/**
 * Simulation harness: loads the REAL service-worker.js against a mock chrome.*
 * API and drives it through the core scenarios:
 *
 *   1. Browser startup with 20 restored tabs → 18 discarded (active + excluded kept).
 *   2. User activates one unloaded tab → only that tab loads, nothing else.
 *   3. The initially active restored tab is discarded once the user switches away.
 *   4. Inactivity timeout elapses → the previously active tab is discarded.
 *   5. Shortening the timeout applies immediately.
 *   6. Fresh install (onInstalled) → existing tabs are NOT discarded.
 *   7. Snapshot message returns accurate counts.
 *   8. Manual bulk unload respects protections; removal cleans state.
 *
 * Run: node tools/simulate.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises';

/* ---------------- controllable clock ---------------- */
let fakeNow = 1_000_000_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow;
const advance = (ms) => { fakeNow += ms; };

/* ---------------- mock chrome ---------------- */
function makeChrome() {
  const L = {
    onStartup: [], onInstalled: [], onMessage: [], onAlarm: [],
    onActivated: [], onCreated: [], onRemoved: [], onUpdated: [],
    onFocusChanged: [], storageChanged: []
  };
  const localData = {};
  const sessionData = {};
  const alarms = {};
  const tabMap = new Map();

  const fire = (name, ...args) => L[name].forEach((fn) => void fn(...args));

  const area = (data, areaName) => ({
    async get(keys) {
      const out = {};
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(data);
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      if (areaName === 'local') fire('storageChanged', changes, 'local');
    }
  });

  const evt = (name) => ({ addListener: (fn) => L[name].push(fn) });

  const chrome = {
    storage: {
      local: area(localData, 'local'),
      session: area(sessionData, 'session'),
      onChanged: evt('storageChanged')
    },
    alarms: {
      async get(name) { return alarms[name]; },
      async create(name, opts) { alarms[name] = { name, ...opts }; },
      onAlarm: evt('onAlarm')
    },
    runtime: {
      onStartup: evt('onStartup'),
      onInstalled: evt('onInstalled'),
      onMessage: evt('onMessage'),
      async openOptionsPage() {}
    },
    tabs: {
      onActivated: evt('onActivated'),
      onCreated: evt('onCreated'),
      onRemoved: evt('onRemoved'),
      onUpdated: evt('onUpdated'),
      async query(filter = {}) {
        let list = [...tabMap.values()];
        if (filter.active !== undefined) list = list.filter((t) => t.active === filter.active);
        if (filter.windowId !== undefined) list = list.filter((t) => t.windowId === filter.windowId);
        return list.map((t) => ({ ...t }));
      },
      async get(id) {
        const t = tabMap.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        return { ...t };
      },
      async update(id, props) {
        const t = tabMap.get(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        if (props && props.active) {
          for (const other of tabMap.values()) {
            if (other.windowId === t.windowId) other.active = other.id === id;
          }
          fire('onActivated', { tabId: id, windowId: t.windowId });
        }
        return { ...t };
      },
      async discard(id) {
        const t = tabMap.get(id);
        // Mirrors Chrome: does nothing (resolves undefined) for active or
        // already-discarded tabs — and, when the test enables it, while a
        // navigation is still in flight (mirrors Chrome refusing discards
        // during session restore).
        const refused = !t || t.active || t.discarded || (t.status === 'loading' && __test.refuseWhileLoading);
        if (process.env.DEBUG_TU) console.log(`  [mock] discard(${id}) → ${refused ? 'refused' : 'discarded'}`);
        if (refused) return undefined;
        t.discarded = true;
        t.status = 'unloaded';
        return { ...t };
      }
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: evt('onFocusChanged')
    }
  };

  /* test helpers (not part of the chrome API) */
  const __test = {
    localData,
    sessionData,
    alarms,
    fire,
    refuseWhileLoading: false,
    addTab(props) {
      const tab = {
        id: props.id,
        windowId: props.windowId ?? 1,
        url: props.url ?? `https://site${props.id}.test/`,
        title: `Tab ${props.id}`,
        active: Boolean(props.active),
        discarded: Boolean(props.discarded),
        pinned: Boolean(props.pinned),
        audible: Boolean(props.audible),
        status: props.status ?? (props.discarded ? 'unloaded' : 'complete'),
        openerTabId: props.openerTabId,
        groupId: props.groupId ?? -1 // -1 = TAB_GROUP_ID_NONE, as in real Chrome
      };
      tabMap.set(tab.id, tab);
      return tab;
    },
    removeTab(id) { tabMap.delete(id); },
    tab(id) { return tabMap.get(id); },
    all() { return [...tabMap.values()]; },
    setActive(id, windowId = 1) {
      for (const t of tabMap.values()) if (t.windowId === windowId) t.active = t.id === id;
      fire('onActivated', { tabId: id, windowId });
    },
    updateStatus(id, status) {
      const t = tabMap.get(id);
      t.status = status;
      if (status === 'loading' || status === 'complete') t.discarded = false;
      fire('onUpdated', id, { status }, { ...t });
    },
    activate(id) {
      // What Chrome really does: select the tab, then reload a discarded page.
      this.setActive(id);
      if (this.tab(id).discarded) this.updateStatus(id, 'loading');
      this.updateStatus(id, 'complete');
    },
    async alarmTick() { fire('onAlarm', { name: 'tabunloader-sweep' }); },
    async message(msg) {
      const responses = [];
      for (const fn of L.onMessage) {
        await new Promise((resolve) => {
          const keep = fn(msg, {}, (resp) => { responses.push(resp); resolve(); });
          if (keep !== true) resolve();
        });
      }
      return responses[0];
    },
    startup() { fire('onStartup'); },
    installed(reason) { fire('onInstalled', { reason }); }
  };

  return { chrome, __test };
}

/* ---------------- assertions ---------------- */
let failures = 0;
function assert(name, cond, detail = '') {
  if (cond) console.log(`ok   ${name}`);
  else { failures += 1; console.error(`FAIL ${name} ${detail}`); }
}
const settle = async (ms = 40) => { await sleep(ms); };

/* =================================================================== *
 * Instance 1: startup / activation / inactivity / timeout change
 * =================================================================== */
const m1 = makeChrome();
globalThis.chrome = m1.chrome;
await import('../service-worker.js');
await settle();

const t1 = m1.__test;
for (let i = 1; i <= 20; i++) {
  t1.addTab({ id: i, url: i === 13 ? 'https://mail.example.com/inbox' : undefined, active: i === 1 });
}
await m1.chrome.storage.local.set({ settings: { version: 1, exclusions: ['mail.example.com'] } });
await settle();

/* --- Scenario 1: startup --- */
t1.startup();
await settle(80);
const d = (n) => Array.from({ length: n }, (_, k) => t1.tab(k + 1)).filter((x) => x.discarded).length;
assert('S1: 18 of 20 restored tabs discarded', d(20) === 18, `got ${d(20)}`);
assert('S1: initially active tab kept loaded', !t1.tab(1).discarded);
assert('S1: excluded site kept loaded', !t1.tab(13).discarded);
assert('S1: discarded tab keeps original URL', t1.tab(2).url === 'https://site2.test/');
assert('S1: all 20 tabs still open', t1.all().length === 20);

/* --- Scenario 2: user activates one unloaded tab --- */
t1.activate(7);
await settle(60);
assert('S2: activated tab is loaded', !t1.tab(7).discarded);
assert(
  'S2: every other non-excluded tab stayed unloaded',
  t1.all().every((x) => x.id === 1 || x.id === 7 || x.id === 13 || x.discarded)
);

/* --- Scenario 3: initially active tab discarded after switching away --- */
t1.activate(2); // user clicks tab 2 → Chrome reloads it (it was discarded at startup)
await settle(30);
assert('S3: tab 2 reloads after user activation', !t1.tab(2).discarded);
advance(31 * 1000);
await t1.alarmTick();
await settle(60);
assert('S3: startup-gated tab 1 discarded once it lost focus', t1.tab(1).discarded);

/* --- Scenario 4: inactivity timeout (default 5 min) --- */
advance(4 * 60 * 1000);
await t1.alarmTick();
await settle(60);
assert('S4: tab 7 not discarded before 5 minutes elapse', !t1.tab(7).discarded, 'discarded too early');
advance(61 * 1000);
await t1.alarmTick();
await settle(60);
assert('S4: tab 7 discarded after 5 minutes of inactivity', t1.tab(7).discarded);
assert('S4: active tab 2 untouched', !t1.tab(2).discarded);

/* --- Scenario 5: shortening the timeout applies immediately --- */
t1.activate(5); // reloads tab 5 (was discarded at startup)
await settle(30);
assert('S5: tab 5 loaded again after activation', !t1.tab(5).discarded);
await m1.chrome.storage.local.set({ settings: { version: 1, exclusions: ['mail.example.com'], inactivitySeconds: 30 } });
await settle(60); // storage.onChanged triggers an immediate sweep
t1.setActive(2);
await settle(30); // let the onActivated handler record the new inactive timestamp
advance(31 * 1000);
await t1.alarmTick();
await settle(60);
assert('S5: 30s timeout discards tab 5 promptly', t1.tab(5).discarded);
assert('S5: active tab 2 still untouched', !t1.tab(2).discarded);

/* =================================================================== *
 * Instance 2: fresh install, snapshot counts, bulk unload, removal
 * =================================================================== */
const m2 = makeChrome();
globalThis.chrome = m2.chrome;
await import('../service-worker.js?install'); // fresh module instance = fresh worker
await settle();

const t2 = m2.__test;
t2.addTab({ id: 1, url: 'https://a.test/', active: true });
t2.addTab({ id: 2, url: 'https://b.test/' });
t2.addTab({ id: 3, url: 'https://blocked.test/' });
t2.addTab({ id: 4, url: 'https://c.test/', discarded: true });
await settle();

/* --- Scenario 6: fresh install does not discard existing tabs --- */
t2.installed('install');
await settle(80);
assert('S6: install leaves all loaded tabs alone', t2.all().filter((x) => !x.discarded).length === 3);
assert('S6: startup gate did not fire (tab 2 still loaded)', !t2.tab(2).discarded);

/* --- Scenario 7: snapshot counts --- */
await m2.chrome.storage.local.set({ settings: { version: 1, exclusions: ['blocked.test'] } });
await settle(60);
let snap = await t2.message({ type: 'snapshot' });
assert('S7: snapshot responds ok', snap?.ok === true);
assert('S7: total = 4', snap?.counts?.total === 4, `got ${snap?.counts?.total}`);
assert('S7: loaded = 3', snap?.counts?.loaded === 3, `got ${snap?.counts?.loaded}`);
assert('S7: unloaded = 1', snap?.counts?.unloaded === 1, `got ${snap?.counts?.unloaded}`);
assert('S7: waiting = 1 (discarded, never loaded)', snap?.counts?.waiting === 1, `got ${snap?.counts?.waiting}`);
assert('S7: excluded = 1', snap?.counts?.excluded === 1, `got ${snap?.counts?.excluded}`);
assert('S7: loaded breakdown lists every loaded tab', Array.isArray(snap?.loadedTabs) && snap.loadedTabs.length === 3, JSON.stringify(snap?.loadedTabs));
assert('S7: breakdown explains the excluded tab',
  (snap?.loadedTabs || []).some((x) => x.host === 'blocked.test' && /exclusions/.test(x.reason)), JSON.stringify(snap?.loadedTabs));
assert('S7: breakdown marks the active tab',
  (snap?.loadedTabs || []).some((x) => x.active === true && x.host === 'a.test'), JSON.stringify(snap?.loadedTabs));

/* --- Scenario 8: bulk unload respects protections; removal cleans state --- */
t2.tab(2).pinned = true; // pinned protection is on by default
let bulk = await t2.message({ type: 'unloadAll' });
assert('S8: unloadAll skips pinned tab', bulk?.discarded === 0 && !t2.tab(2).discarded, JSON.stringify(bulk));
t2.tab(2).pinned = false;
bulk = await t2.message({ type: 'unloadAll' });
assert('S8: unloadAll discards the eligible tab only', bulk?.discarded === 1 && bulk?.failed === 0, JSON.stringify(bulk));
assert('S8: excluded tab still loaded', !t2.tab(3).discarded);
assert('S8: active tab still loaded', !t2.tab(1).discarded);

snap = await t2.message({ type: 'snapshot' });
assert('S8: nothing eligible remains', snap?.counts?.unloadable === 0, `got ${snap?.counts?.unloadable}`);

t2.removeTab(4);
t2.fire('onRemoved', 4, { windowId: 1, isWindowClosing: false });
await settle(40);
snap = await t2.message({ type: 'snapshot' });
assert('S8: total drops to 3 after removal', snap?.counts?.total === 3, `got ${snap?.counts?.total}`);

/* =================================================================== *
 * Instance 3: gate recovers when Chrome refuses discards during restore
 * (the "restored tab still using memory" regression)
 * =================================================================== */
const m3 = makeChrome();
globalThis.chrome = m3.chrome;
await import('../service-worker.js?gate'); // fresh worker instance
await settle();

const t3 = m3.__test;
t3.refuseWhileLoading = true; // Chrome refuses discards while a load is in flight
t3.addTab({ id: 1, url: 'https://github.com/user', active: true });
t3.addTab({ id: 2, url: 'https://spring.io/guides/gs/spring-boot', status: 'loading' });
await settle();

t3.startup();
await settle(60);
advance(9 * 1000); await t3.alarmTick(); await settle(60); // attempt 2
advance(9 * 1000); await t3.alarmTick(); await settle(60); // attempt 3
assert('S9: gate exhausts its budget while Chrome keeps refusing', !t3.tab(2).discarded);

// Chrome finishes/aborts and re-navigates the restored tab later.
t3.updateStatus(2, 'loading');
await settle(60);
advance(9 * 1000); await t3.alarmTick(); await settle(60);
t3.updateStatus(2, 'complete');
await settle(60);
advance(9 * 1000); await t3.alarmTick(); await settle(60);
assert('S9: gate recovers on the tab\'s next load and discards it', t3.tab(2).discarded);

snap = await t3.message({ type: 'snapshot' });
assert('S9: guarded count = only the still-loaded active tab', snap?.counts?.guarded === 1, `got ${snap?.counts?.guarded}`);
assert('S9: the user\'s active tab was never touched', !t3.tab(1).discarded);

/* --- S10: "Unload this tab" — refusal on focused tab, then switch-away --- */
const refused = await t3.message({ type: 'unloadCurrent' });
assert('S10: unloading the focused tab is refused with an explanation',
  refused?.ok === false && /currently in focus/.test(refused?.message || ''), JSON.stringify(refused));

const switched = await t3.message({ type: 'unloadCurrent', switchAway: true });
assert('S10: switch-away unload succeeds after explicit consent', switched?.ok === true, JSON.stringify(switched));
assert('S10: the original tab is now discarded', t3.tab(1).discarded);
assert('S10: the neighbouring tab became active', t3.tab(2).active);

/* =================================================================== *
 * Instance 4: group load guard — opening a tab group must not keep
 * every one of its tabs loaded
 * =================================================================== */
const m4 = makeChrome();
globalThis.chrome = m4.chrome;
await import('../service-worker.js?group'); // fresh worker instance
await settle();

const t4 = m4.__test;
t4.refuseWhileLoading = true; // Chrome refuses discards while a load is in flight
t4.addTab({ id: 1, url: 'https://start.test/', active: true });           // the window's active tab
t4.addTab({ id: 2, url: 'https://a.test/', groupId: 5 });                 // group member, never opened
t4.addTab({ id: 3, url: 'https://b.test/' });                             // not in any group
t4.addTab({ id: 4, url: 'https://c.test/', groupId: 5 });                 // group member used earlier
t4.addTab({ id: 5, url: 'https://d.test/', groupId: 5, openerTabId: 1 }); // deliberately opened by the user
await settle();

// The user opened tab 4 once earlier this session, then returned to tab 1.
t4.activate(4);
t4.setActive(1);
await settle(60);

// Now the user opens the group: Chrome loads every member in the background.
t4.updateStatus(2, 'loading');
await settle(60);
t4.updateStatus(3, 'loading'); // background load outside the group, for contrast
await settle(60);
t4.updateStatus(5, 'loading');
await settle(60);
t4.updateStatus(4, 'loading');
await settle(60);
t4.updateStatus(2, 'complete'); // loads finish; guard retries where Chrome refused mid-load
await settle(60);
t4.updateStatus(3, 'complete');
await settle(60);
t4.updateStatus(5, 'complete');
await settle(60);
t4.updateStatus(4, 'complete');
await settle(60);

assert('S11: background group tab unloaded after the group opened', t4.tab(2).discarded);
assert('S11: non-group background load left alone', !t4.tab(3).discarded);
assert('S11: previously used group tab left alone', !t4.tab(4).discarded);
assert('S11: deliberately opened group tab (with opener) left alone', !t4.tab(5).discarded);
assert('S11: active tab untouched', !t4.tab(1).discarded);

// Turning the guard off restores plain Chrome behaviour for group loads.
await m4.chrome.storage.local.set({ settings: { version: 1, groupTabGuard: false } });
await settle(60);
t4.updateStatus(2, 'loading');
await settle(60);
t4.updateStatus(2, 'complete');
await settle(60);
assert('S11: with the guard off, group loads behave like plain Chrome', !t4.tab(2).discarded);

/* ---------------- report ---------------- */
Date.now = realDateNow;
if (failures > 0) {
  console.error(`\n${failures} simulation assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll simulation scenarios passed.');
process.exit(0);
