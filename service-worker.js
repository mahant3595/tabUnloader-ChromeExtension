/**
 * TabUnloader — Manifest V3 service worker.
 *
 * Responsibilities:
 *  - Startup protection: keep session-restored tabs unloaded until the user
 *    activates them (strongest behavior Chrome's APIs allow — see README).
 *  - Inactivity unloading: discard loaded inactive tabs after the configured
 *    timeout using chrome.alarms-driven sweeps (no long-lived timers/polling).
 *  - Manual controls & statistics for the popup via runtime messaging.
 *  - Event-driven state, persisted in chrome.storage.session so it survives
 *    service-worker suspension; chrome.storage.local holds user settings.
 *
 * The only unloading mechanism is chrome.tabs.discard(). Tabs are never closed.
 */

import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  normalizeSettings,
  effectiveTimeoutSeconds,
  formatTimeout,
  autoEligible,
  isInternalUrl,
  hostnameOf,
  urlExcluded
} from './common.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const RUNTIME_KEY = 'tuRuntime';
const SWEEP_ALARM = 'tabunloader-sweep';
const SWEEP_PERIOD_MIN = 0.5; // Chrome's minimum alarm period in packaged extensions
const STARTUP_PHASE_MS = 3 * 60 * 1000; // collect "restored" candidates for 3 minutes
const MAX_DISCARD_ATTEMPTS = 3; // per tab per activation cycle (prevents loops)
const AUTO_RETRY_COOLDOWN_MS = 8 * 1000;

/**
 * autoEligible() reasons that must NOT block the startup gate or a manual
 * bulk unload — those features are explicitly user-controlled and independent
 * of the inactivity timer.
 */
const POLICY_ONLY_REASONS = new Set([
  'paused',
  'auto-unload-disabled',
  'timeout-never'
]);

/* ------------------------------------------------------------------ *
 * In-memory runtime state (mirrored to chrome.storage.session)
 * ------------------------------------------------------------------ */

function freshRuntime() {
  return {
    pendingStartup: false, // startup pass not yet executed this browser session
    startupPhaseEnd: 0, // candidate collection window after startup
    startupSet: new Set(), // restored tabs that must stay unloaded until activated
    activated: new Set(), // tabs the user explicitly activated this session
    created: new Set(), // tabs created during this session (not restored)
    loaded: new Set(), // tabs observed loading/complete this session
    protectedIds: new Set(), // user-protected tabs (session scope)
    inactiveSince: new Map(), // tabId -> ms timestamp when it became inactive
    attempts: new Map(), // tabId -> failed discard attempts since last activation
    lastAttemptAt: new Map(), // tabId -> ms timestamp (memory only, anti-thrash)
    lastActiveByWindow: new Map(), // windowId -> tabId
    lastFocusedWindow: null,
    paused: false, // session pause of automatic inactivity unloading
    stats: { auto: 0, manual: 0, failed: 0 }
  };
}

function serializeRuntime(rt) {
  return {
    pendingStartup: rt.pendingStartup,
    startupPhaseEnd: rt.startupPhaseEnd,
    startupSet: [...rt.startupSet],
    activated: [...rt.activated],
    created: [...rt.created],
    loaded: [...rt.loaded],
    protectedIds: [...rt.protectedIds],
    inactiveSince: Object.fromEntries(rt.inactiveSince),
    attempts: Object.fromEntries(rt.attempts),
    lastActiveByWindow: Object.fromEntries(rt.lastActiveByWindow),
    lastFocusedWindow: rt.lastFocusedWindow,
    paused: rt.paused,
    stats: { ...rt.stats }
  };
}

function deserializeRuntime(raw) {
  const rt = freshRuntime();
  if (!raw || typeof raw !== 'object') return rt;
  const arr = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : []);
  const entries = (v) =>
    v && typeof v === 'object'
      ? Object.entries(v).filter(([k]) => Number.isInteger(Number(k)))
      : [];
  rt.pendingStartup = Boolean(raw.pendingStartup);
  rt.startupPhaseEnd = Number(raw.startupPhaseEnd) || 0;
  rt.startupSet = new Set(arr(raw.startupSet));
  rt.activated = new Set(arr(raw.activated));
  rt.created = new Set(arr(raw.created));
  rt.loaded = new Set(arr(raw.loaded));
  rt.protectedIds = new Set(arr(raw.protectedIds));
  rt.inactiveSince = new Map(entries(raw.inactiveSince).map(([k, v]) => [Number(k), Number(v) || 0]));
  rt.attempts = new Map(entries(raw.attempts).map(([k, v]) => [Number(k), Number(v) || 0]));
  rt.lastActiveByWindow = new Map(
    entries(raw.lastActiveByWindow).map(([k, v]) => [Number(k), Number(v)])
  );
  rt.lastFocusedWindow = Number.isInteger(raw.lastFocusedWindow) ? raw.lastFocusedWindow : null;
  rt.paused = Boolean(raw.paused);
  rt.stats = {
    auto: Number(raw.stats?.auto) || 0,
    manual: Number(raw.stats?.manual) || 0,
    failed: Number(raw.stats?.failed) || 0
  };
  return rt;
}

let settings = normalizeSettings(null);
let rt = freshRuntime();

/* ------------------------------------------------------------------ *
 * Boot / persistence
 * ------------------------------------------------------------------ */

let readyPromise = null;
let flushTimer = null;
let sweepInFlight = null;
let lastFlushed = '';

function ensureReady() {
  if (!readyPromise) {
    readyPromise = init().catch((err) => {
      readyPromise = null; // allow retry on next wake
      throw err;
    });
  }
  return readyPromise;
}

async function init() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = normalizeSettings(stored[SETTINGS_KEY]);
  if (!stored[SETTINGS_KEY]) {
    // First run: materialize defaults so the options page has a source of truth.
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  }
  const session = await chrome.storage.session.get(RUNTIME_KEY);
  rt = session[RUNTIME_KEY] ? deserializeRuntime(session[RUNTIME_KEY]) : freshRuntime();
  lastFlushed = JSON.stringify(serializeRuntime(rt));
  await ensureAlarm();
}

/**
 * Persist runtime state, skipping the write when nothing changed (keeps
 * storage writes minimal on idle sweeps).
 */
async function flush() {
  const payload = serializeRuntime(rt);
  const json = JSON.stringify(payload);
  if (json === lastFlushed) return;
  try {
    await chrome.storage.session.set({ [RUNTIME_KEY]: payload });
    lastFlushed = json;
  } catch (err) {
    console.warn('TabUnloader: could not persist runtime state', err);
  }
}

/** Debounced persist for chatty events (tab loading). */
function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 400);
}

/** One recurring alarm drives all scheduled work (Chrome minimum: 30s). */
async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(SWEEP_ALARM);
    if (!existing || existing.periodInMinutes !== SWEEP_PERIOD_MIN) {
      await chrome.alarms.create(SWEEP_ALARM, {
        delayInMinutes: SWEEP_PERIOD_MIN,
        periodInMinutes: SWEEP_PERIOD_MIN
      });
    }
  } catch (err) {
    console.warn('TabUnloader: could not create sweep alarm', err);
  }
}

/* ------------------------------------------------------------------ *
 * Core logic
 * ------------------------------------------------------------------ */

function sweepContext() {
  return { settings, protectedIds: rt.protectedIds, paused: rt.paused };
}

/** Reasons allowed by the startup gate / manual bulk unload. */
function policyAllows(tab) {
  const verdict = autoEligible(tab, sweepContext());
  return verdict.ok || POLICY_ONLY_REASONS.has(verdict.reason);
}

/**
 * Mark a tab as a session-restored candidate that must stay unloaded until
 * the user activates it. Called at startup and throughout the startup phase.
 */
function markStartupCandidate(tab) {
  if (!settings.startupProtection) return;
  if (rt.activated.has(tab.id)) return;
  if (tab.discarded) return; // already unloaded — nothing to gate
  if (tab.active && settings.loadActiveTabOnStartup) {
    rt.startupSet.delete(tab.id); // user opted to let the initial tab load
    return;
  }
  // Tabs with an opener were created by the user (e.g. middle-click), not restored.
  if (Number.isInteger(tab.openerTabId) && tab.openerTabId >= 0) {
    rt.created.add(tab.id);
    return;
  }
  rt.startupSet.add(tab.id);
}

/**
 * Try to discard one tab. kind: 'startup' | 'auto' | 'manual'.
 * Verifies the result — Chrome resolves with undefined when it refuses.
 */
async function discardTab(tab, kind) {
  const now = Date.now();
  const isAutomatic = kind !== 'manual';

  if (isAutomatic) {
    const last = rt.lastAttemptAt.get(tab.id) || 0;
    if (now - last < AUTO_RETRY_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    const fails = rt.attempts.get(tab.id) || 0;
    if (fails >= MAX_DISCARD_ATTEMPTS) {
      return { ok: false, reason: 'attempts-exhausted', message: 'Gave up after repeated failures.' };
    }
    rt.lastAttemptAt.set(tab.id, now);
    rt.attempts.set(tab.id, fails + 1);
  }

  try {
    const result = await chrome.tabs.discard(tab.id);
    if (result && result.discarded) {
      if (kind === 'manual') rt.stats.manual += 1;
      else rt.stats.auto += 1;
      rt.inactiveSince.delete(tab.id);
      return { ok: true };
    }
    rt.stats.failed += 1;
    return {
      ok: false,
      reason: 'chrome-refused',
      message: tab.active
        ? 'Chrome does not allow discarding the active tab.'
        : 'Chrome refused to discard this tab (it may be internal, already reloading, or restricted).'
    };
  } catch (err) {
    rt.stats.failed += 1;
    const message = String(err?.message || err);
    if (/cannot be discarded|cannot discard/i.test(message)) {
      return { ok: false, reason: 'not-discardable', message: 'Chrome reports this tab cannot be discarded.' };
    }
    return { ok: false, reason: 'error', message };
  }
}

function prune(aliveTabs) {
  const alive = new Set(aliveTabs.map((t) => t.id));
  for (const set of [rt.startupSet, rt.activated, rt.created, rt.loaded, rt.protectedIds]) {
    for (const id of set) if (!alive.has(id)) set.delete(id);
  }
  for (const map of [rt.inactiveSince, rt.attempts, rt.lastAttemptAt]) {
    for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
  }
  for (const [windowId, tabId] of rt.lastActiveByWindow) {
    if (!alive.has(tabId)) rt.lastActiveByWindow.delete(windowId);
  }
}

/** Startup gate: discard restored tabs that are not discarded yet. */
async function gatePass(tabs) {
  if (!settings.startupProtection || rt.startupSet.size === 0) return;
  for (const tab of tabs) {
    if (!rt.startupSet.has(tab.id)) continue;
    if (rt.activated.has(tab.id)) {
      rt.startupSet.delete(tab.id); // user opened it → normal rules apply from now on
      continue;
    }
    if (tab.active && settings.loadActiveTabOnStartup) {
      rt.startupSet.delete(tab.id);
      continue;
    }
    if (tab.discarded) {
      // Already unloaded. Keep guarding it while the session-restore machinery
      // is still active (it can re-navigate a discarded restored tab); once the
      // startup phase has passed, drop it so future sweeps stay cheap.
      if (Date.now() > rt.startupPhaseEnd) rt.startupSet.delete(tab.id);
      continue;
    }
    if (tab.active) continue; // active tabs cannot be discarded by Chrome
    if (isInternalUrl(tab.url)) continue; // chrome:// and friends
    if (!policyAllows(tab)) continue; // protected / excluded / pinned / audio rules
    await discardTab(tab, 'startup');
  }
}

/**
 * The recurring sweep. Runs every 30s via chrome.alarms and exits early
 * (without any tabs.query) when there is no scheduled work.
 */
async function doSweep() {
  await ensureReady();
  const now = Date.now();
  const startupNow = rt.pendingStartup;
  const inStartupPhase = now <= rt.startupPhaseEnd;
  const timeout = effectiveTimeoutSeconds(settings);
  const autoOn = settings.autoUnload && !rt.paused && timeout > 0;

  if (!startupNow && !inStartupPhase && rt.startupSet.size === 0 && !autoOn) {
    return; // nothing to do — no tab query, no work
  }

  const tabs = await chrome.tabs.query({});
  rt.pendingStartup = false;
  prune(tabs);

  if (settings.startupProtection) {
    if (startupNow || inStartupPhase) {
      for (const tab of tabs) markStartupCandidate(tab);
    }
    await gatePass(tabs);
  }

  if (autoOn) {
    const ctx = sweepContext();
    for (const tab of tabs) {
      if (tab.active) {
        rt.lastActiveByWindow.set(tab.windowId, tab.id);
        rt.inactiveSince.delete(tab.id);
        continue;
      }
      if (tab.discarded) {
        rt.inactiveSince.delete(tab.id);
        continue;
      }
      const since = rt.inactiveSince.get(tab.id);
      if (since === undefined) {
        rt.inactiveSince.set(tab.id, now); // first observed inactive → start the timer
        continue;
      }
      if (now - since < timeout * 1000) continue;
      if (!autoEligible(tab, ctx).ok) continue;
      await discardTab(tab, 'auto');
    }
  } else {
    // Still track basic inactivity transitions cheaply for correct resumption.
    for (const tab of tabs) {
      if (tab.active) {
        rt.lastActiveByWindow.set(tab.windowId, tab.id);
        rt.inactiveSince.delete(tab.id);
      } else if (!tab.discarded && !rt.inactiveSince.has(tab.id)) {
        rt.inactiveSince.set(tab.id, now);
      }
    }
  }

  await flush();
}

function runSweep() {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = doSweep().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

/* ------------------------------------------------------------------ *
 * Runtime messages (popup / options)
 * ------------------------------------------------------------------ */

function buildCounts(tabs) {
  const counts = {
    total: tabs.length,
    loaded: 0,
    unloaded: 0,
    waiting: 0,
    protected: 0,
    excluded: 0,
    active: 0,
    internal: 0,
    unloadable: 0,
    guarded: 0
  };
  for (const tab of tabs) {
    if (!tab.discarded && rt.startupSet.has(tab.id)) {
      counts.guarded += 1; // restored tab still loaded under startup guard
    }
    if (tab.discarded) {
      counts.unloaded += 1;
      if (!rt.loaded.has(tab.id)) counts.waiting += 1;
    } else {
      counts.loaded += 1;
    }
    if (tab.active) counts.active += 1;
    if (isInternalUrl(tab.url)) counts.internal += 1;
    if (rt.protectedIds.has(tab.id)) counts.protected += 1;
    if (urlExcluded(tab.url, settings.exclusions)) counts.excluded += 1;
    if (!tab.active && !tab.discarded && !isInternalUrl(tab.url) && policyAllows(tab)) {
      counts.unloadable += 1; // eligible for a manual bulk unload right now
    }
  }
  return counts;
}

/** Human-readable explanations for why a tab is still loaded. */
const LOADED_REASON_TEXT = {
  'active-or-already-unloaded': 'Active in its window',
  'cannot-be-discarded': 'Cannot be discarded',
  'protected-by-user': 'Protected by you',
  'excluded-by-rules': 'Site is in your exclusions',
  pinned: 'Pinned',
  'playing-audio': 'Playing audio',
  paused: 'Automatic unloading paused',
  'auto-unload-disabled': 'Automatic unloading is off',
  'timeout-never': 'Timeout is set to Never'
};

/**
 * Per-tab breakdown of why each loaded tab is still loaded — lets the user
 * hunt down the last remaining memory consumers instead of guessing.
 */
function buildLoadedBreakdown(tabs) {
  const timeout = effectiveTimeoutSeconds(settings);
  const now = Date.now();
  const out = [];
  for (const tab of tabs) {
    if (tab.discarded || isInternalUrl(tab.url)) continue;
    const verdict = autoEligible(tab, sweepContext());
    let reason;
    if (verdict.ok) {
      const since = rt.inactiveSince.get(tab.id);
      const idleFor = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
      reason =
        timeout === 0
          ? 'Eligible (timer set to Never)'
          : idleFor >= timeout
            ? 'Eligible — unloads at the next check'
            : `Idle ${idleFor}s of ${formatTimeout(timeout)}`;
    } else {
      reason = LOADED_REASON_TEXT[verdict.reason] || verdict.reason;
    }
    out.push({
      id: tab.id,
      host: hostnameOf(tab.url) || tab.url,
      reason,
      active: Boolean(tab.active),
      windowId: tab.windowId
    });
  }
  out.sort((a, b) => Number(b.active) - Number(a.active) || a.host.localeCompare(b.host));
  return out;
}

async function handleMessage(msg) {
  await ensureReady();
  switch (msg?.type) {
    case 'snapshot': {
      const tabs = await chrome.tabs.query({});
      prune(tabs);
      return {
        ok: true,
        settings,
        paused: rt.paused,
        stats: { ...rt.stats },
        protectedIds: [...rt.protectedIds],
        loadedIds: [...rt.loaded],
        counts: buildCounts(tabs),
        loadedTabs: buildLoadedBreakdown(tabs),
        startupActive: rt.pendingStartup || Date.now() <= rt.startupPhaseEnd
      };
    }

    case 'unloadCurrent': {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, message: 'No active tab found.' };

      // Chrome never discards the focused tab. With explicit user consent we
      // switch to a neighbouring tab first, then discard the original one.
      if (msg.switchAway && tab.active) {
        const windowTabs = (await chrome.tabs.query({ windowId: tab.windowId })).sort(
          (a, b) => a.index - b.index
        );
        const idx = windowTabs.findIndex((t) => t.id === tab.id);
        const next = windowTabs[idx + 1] || windowTabs[idx - 1];
        if (!next) {
          return { ok: false, message: 'This is the only tab in the window — nothing to switch to.' };
        }
        await chrome.tabs.update(next.id, { active: true });
        const fresh = await chrome.tabs.get(tab.id).catch(() => null);
        if (!fresh) return { ok: false, message: 'Tab no longer exists.' };
        const res = await discardTab(fresh, 'manual');
        await flush();
        if (res.ok) {
          return {
            ok: true,
            switched: true,
            message:
              'Switched to the next tab and unloaded this one. It stays open and reloads when you click it again.'
          };
        }
        return { ok: false, message: res.message || 'Chrome did not permit discarding this tab.' };
      }

      const res = await discardTab(tab, 'manual');
      await flush();
      if (res.ok) {
        return { ok: true, message: 'Tab unloaded. It stays open and reloads when you activate it.' };
      }
      if (tab.active) {
        return {
          ok: false,
          message:
            'Chrome does not allow discarding the tab that is currently in focus. Switch away from it and TabUnloader will unload it once the inactivity period elapses, or use "Unload all eligible inactive tabs".'
        };
      }
      return { ok: false, message: res.message || 'Chrome did not permit discarding this tab.' };
    }

    case 'unloadAll': {
      const tabs = await chrome.tabs.query({});
      prune(tabs);
      let discarded = 0;
      let failed = 0;
      for (const tab of tabs) {
        if (tab.active || tab.discarded || isInternalUrl(tab.url)) continue;
        if (!policyAllows(tab)) continue;
        const res = await discardTab(tab, 'manual');
        if (res.ok) discarded += 1;
        else failed += 1;
      }
      await flush();
      return { ok: true, discarded, failed };
    }

    case 'setProtected': {
      const tabId = Number(msg.tabId);
      if (!Number.isInteger(tabId)) return { ok: false, message: 'Invalid tab id.' };
      if (msg.value) rt.protectedIds.add(tabId);
      else rt.protectedIds.delete(tabId);
      await flush();
      return { ok: true, protectedIds: [...rt.protectedIds] };
    }

    case 'togglePause': {
      rt.paused = !rt.paused;
      await flush();
      return { ok: true, paused: rt.paused };
    }

    case 'setPaused': {
      rt.paused = Boolean(msg.value);
      await flush();
      return { ok: true, paused: rt.paused };
    }

    case 'keepLoaded': {
      const tabId = Number(msg.tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { ok: false, message: 'Tab no longer exists.' };
      if (settings.keepLoadedMode === 'permanent') {
        const host = hostnameOf(tab.url);
        if (!host) return { ok: false, message: 'This page has no website host to protect.' };
        const next = normalizeSettings({
          ...settings,
          exclusions: [...settings.exclusions, host]
        });
        await chrome.storage.local.set({ [SETTINGS_KEY]: next });
        settings = next;
        await flush();
        return {
          ok: true,
          mode: 'permanent',
          message: `Protected: every tab on ${host} will stay loaded.`
        };
      }
      rt.protectedIds.add(tabId);
      await flush();
      return { ok: true, mode: 'temporary', message: 'This tab is protected for this session.' };
    }

    case 'removeSiteRule': {
      const tabId = Number(msg.tabId);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return { ok: false, message: 'Tab no longer exists.' };
      const host = hostnameOf(tab.url);
      const next = normalizeSettings({
        ...settings,
        exclusions: settings.exclusions.filter((p) => p.replace(/^\*\./, '') !== host)
      });
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      settings = next;
      await flush();
      return { ok: true, message: host ? `Removed the rule for ${host}.` : 'No rule removed.' };
    }

    case 'getSettings':
      return { ok: true, settings };

    default:
      return { ok: false, message: 'Unknown message.' };
  }
}

/* ------------------------------------------------------------------ *
 * Listeners (registered synchronously at top level, per MV3 guidance)
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
  return true; // async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) void runSweep().catch((e) => console.warn('TabUnloader sweep failed', e));
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureReady();
    // Session restoration begins here: mark and act as early as the API allows.
    rt.pendingStartup = true;
    rt.startupPhaseEnd = Date.now() + STARTUP_PHASE_MS;
    await flush();
    await runSweep();
  })().catch((e) => console.warn('TabUnloader startup handling failed', e));
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await ensureReady();
    if (details.reason === 'install') {
      // A browser startup never coincides with a fresh install: do not treat
      // existing tabs as "restored" and discard them out from under the user.
      rt.pendingStartup = false;
      rt.startupPhaseEnd = 0;
      await flush();
      await runSweep();
      void chrome.runtime.openOptionsPage();
    } else {
      // update / chrome_update: re-verify state after the worker restarts.
      rt.pendingStartup = false;
      await flush();
      await runSweep();
    }
  })().catch((e) => console.warn('TabUnloader install handling failed', e));
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    await ensureReady();
    const now = Date.now();
    const prev = rt.lastActiveByWindow.get(activeInfo.windowId);
    if (prev !== undefined && prev !== activeInfo.tabId) rt.inactiveSince.set(prev, now);
    rt.lastActiveByWindow.set(activeInfo.windowId, activeInfo.tabId);
    rt.activated.add(activeInfo.tabId); // explicit user activation
    rt.startupSet.delete(activeInfo.tabId);
    rt.inactiveSince.delete(activeInfo.tabId);
    rt.attempts.delete(activeInfo.tabId); // fresh cycle → allow future attempts
    rt.lastAttemptAt.delete(activeInfo.tabId);
    await flush();
  })().catch((e) => console.warn('TabUnloader activation handling failed', e));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  void (async () => {
    await ensureReady();
    const now = Date.now();
    // Chrome started a fresh load of a guarded restored tab → give the gate a
    // fresh attempt budget for this navigation (still capped per navigation,
    // and we never initiate loads ourselves, so this cannot loop).
    if (
      changeInfo.status === 'loading' &&
      rt.startupSet.has(tabId) &&
      !rt.activated.has(tabId)
    ) {
      rt.attempts.delete(tabId);
      rt.lastAttemptAt.delete(tabId);
    }
    rt.loaded.add(tabId); // page has started/finished loading this session
    if (tab.active) {
      rt.inactiveSince.delete(tabId);
    } else if (!rt.inactiveSince.has(tabId)) {
      rt.inactiveSince.set(tabId, now);
    }
    // Startup gate: a restored tab began loading in the background.
    if (
      settings.startupProtection &&
      rt.startupSet.has(tabId) &&
      !rt.activated.has(tabId) &&
      !tab.active &&
      !tab.discarded &&
      !isInternalUrl(tab.url) &&
      policyAllows(tab)
    ) {
      await discardTab(tab, 'startup');
      await flush();
      return;
    }
    // Group load guard: Chrome eagerly loads every tab inside a tab group
    // when the group is opened. The user does not want those background
    // loads kept alive — re-discard the group members they never activated,
    // right away. Tabs with an opener were deliberately opened by the user
    // (middle-click / target=_blank) and are left alone.
    if (
      settings.groupTabGuard &&
      Number.isInteger(tab.groupId) &&
      tab.groupId > 0 &&
      !rt.startupSet.has(tabId) && // the startup gate above owns guarded restored tabs
      !rt.activated.has(tabId) &&
      !(Number.isInteger(tab.openerTabId) && tab.openerTabId >= 0) && // deliberate user open
      !tab.active &&
      !tab.discarded &&
      !isInternalUrl(tab.url) &&
      policyAllows(tab)
    ) {
      // Fresh attempt budget per navigation: Chrome refuses discards while a
      // load is in flight, so retry again at 'complete'. Event-driven only
      // (we never initiate loads ourselves), so this cannot loop.
      rt.attempts.delete(tabId);
      rt.lastAttemptAt.delete(tabId);
      await discardTab(tab, 'group');
      await flush();
      return;
    }
    scheduleFlush();
  })().catch((e) => console.warn('TabUnloader update handling failed', e));
});

chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await ensureReady();
    rt.created.add(tab.id);
    if (tab.active) {
      rt.activated.add(tab.id);
      rt.startupSet.delete(tab.id);
    }
    await flush();
  })().catch((e) => console.warn('TabUnloader create handling failed', e));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await ensureReady(); // never track state for closed tabs
    rt.startupSet.delete(tabId);
    rt.activated.delete(tabId);
    rt.created.delete(tabId);
    rt.loaded.delete(tabId);
    rt.protectedIds.delete(tabId);
    rt.inactiveSince.delete(tabId);
    rt.attempts.delete(tabId);
    rt.lastAttemptAt.delete(tabId);
    for (const [windowId, id] of rt.lastActiveByWindow) {
      if (id === tabId) rt.lastActiveByWindow.delete(windowId);
    }
    await flush();
  })().catch((e) => console.warn('TabUnloader remove handling failed', e));
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // browser unfocused: timers keep running
  void (async () => {
    await ensureReady();
    const prevWindow = rt.lastFocusedWindow;
    rt.lastFocusedWindow = windowId;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (!tab) {
      await flush();
      return;
    }
    rt.inactiveSince.delete(tab.id); // newly focused window's tab is visible now
    if (prevWindow !== null && prevWindow !== windowId) {
      const prevTab = rt.lastActiveByWindow.get(prevWindow);
      if (prevTab !== undefined && prevTab !== tab.id) rt.inactiveSince.set(prevTab, Date.now());
    }
    rt.lastActiveByWindow.set(windowId, tab.id);
    await flush();
  })().catch((e) => console.warn('TabUnloader focus handling failed', e));
});

// Settings changed (options page, popup, or this worker) → apply immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
  // Recalculate eligibility right away instead of waiting for the next alarm.
  void runSweep().catch((e) => console.warn('TabUnloader resweep failed', e));
});

// First wake of this worker: initialize and schedule recurring work.
void ensureReady().catch((e) => console.warn('TabUnloader initialization failed', e));
