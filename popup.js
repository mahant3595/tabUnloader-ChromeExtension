/**
 * TabUnloader — popup controller.
 * Reads settings from chrome.storage.local, live tab state from the service
 * worker (which uses tabs.query — never triggering page loads), and sends
 * user actions to the service worker for safe, single-owner execution.
 */

import {
  SETTINGS_KEY,
  normalizeSettings,
  applyTheme,
  describeTab,
  formatTimeout,
  effectiveTimeoutSeconds,
  TIMEOUT_PRESETS,
  isInternalUrl,
  urlExcluded
} from './common.js';

const $ = (id) => document.getElementById(id);

let settings = normalizeSettings(null);
let snapshot = null;
let currentTab = null;
let confirmAllUntil = 0;
let switchAwayUntil = 0;

/* ---------------- helpers ---------------- */

function feedback(message, kind = 'ok') {
  const el = $('feedback');
  el.textContent = message || '';
  el.className = `feedback ${kind}`;
  if (message) setTimeout(() => { el.textContent = ''; }, 7000);
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

async function saveSettings(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  applyTheme(settings.theme);
  render();
}

function protectedSet() {
  return new Set(snapshot?.protectedIds || []);
}

function loadedSet() {
  return new Set(snapshot?.loadedIds || []);
}

/* ---------------- rendering ---------------- */

function render() {
  const counts = snapshot?.counts || {};
  const paused = Boolean(snapshot?.paused);
  const stats = snapshot?.stats || { auto: 0, manual: 0, failed: 0 };
  const timeout = effectiveTimeoutSeconds(settings);

  applyTheme(settings.theme);

  // Header status
  let statusText;
  if (!settings.autoUnload) statusText = 'Automatic unloading: off';
  else if (paused) statusText = 'Automatic unloading: paused';
  else if (timeout === 0) statusText = 'Automatic unloading: never (timer set to Never)';
  else statusText = `Automatic unloading: on · after ${formatTimeout(timeout)}`;
  $('header-status').textContent = statusText;

  // Startup protection
  $('startup-toggle').checked = Boolean(settings.loadActiveTabOnStartup);
  const startupBadge = $('startup-badge');
  if (!settings.startupProtection) {
    startupBadge.textContent = 'Off';
    startupBadge.className = 'badge warn';
  } else {
    const waiting = counts.waiting ?? 0;
    const guarded = counts.guarded ?? 0;
    if (guarded > 0) {
      startupBadge.textContent = `On · ${guarded} restored still loaded`;
      startupBadge.className = 'badge warn';
    } else {
      startupBadge.textContent = waiting > 0 ? `On · ${waiting} waiting` : 'On';
      startupBadge.className = 'badge ok';
    }
  }

  // Inactivity controls
  $('auto-toggle').checked = Boolean(settings.autoUnload);
  const autoBadge = $('auto-badge');
  autoBadge.textContent = paused ? 'Paused' : settings.autoUnload ? 'On' : 'Off';
  autoBadge.className = `badge ${paused ? 'warn' : settings.autoUnload ? 'ok' : 'err'}`;

  const select = $('timeout-select');
  const isPreset = TIMEOUT_PRESETS.includes(settings.inactivitySeconds);
  select.value = settings.customMode ? 'custom' : String(isPreset ? settings.inactivitySeconds : 'custom');
  $('custom-note').classList.toggle('hidden', !settings.customMode);

  const pauseBtn = $('pause-btn');
  pauseBtn.textContent = paused ? 'Resume automatic unloading' : 'Pause automatic unloading';
  pauseBtn.disabled = !settings.autoUnload;

  // Dashboard
  $('stat-total').textContent = counts.total ?? '–';
  $('stat-loaded').textContent = counts.loaded ?? '–';
  $('stat-unloaded').textContent = counts.unloaded ?? '–';
  $('stat-protected').textContent = counts.protected ?? '–';
  $('stat-detail').textContent =
    `Waiting for activation: ${counts.waiting ?? 0} · Excluded by rules: ${counts.excluded ?? 0} · ` +
    `This session — auto-unloaded: ${stats.auto}, manually: ${stats.manual}, failed attempts: ${stats.failed}`;

  // "Still loaded" breakdown — why every loaded tab is holding memory.
  const loadedTabs = Array.isArray(snapshot?.loadedTabs) ? snapshot.loadedTabs : [];
  const loadedSection = $('loaded-section');
  const loadedList = $('loaded-list');
  if (loadedTabs.length === 0) {
    loadedSection.classList.add('hidden');
  } else {
    loadedSection.classList.remove('hidden');
    loadedList.textContent = '';
    const shown = loadedTabs.slice(0, 10);
    for (const item of shown) {
      const li = document.createElement('li');
      const host = document.createElement('span');
      host.className = 'loaded-host';
      host.textContent = item.host;
      const reason = document.createElement('span');
      reason.className = `loaded-reason${item.active ? ' accent-text' : ''}`;
      reason.textContent = item.reason;
      li.append(host, reason);
      loadedList.appendChild(li);
    }
    if (loadedTabs.length > shown.length) {
      const li = document.createElement('li');
      li.className = 'muted small';
      li.textContent = `+${loadedTabs.length - shown.length} more loaded tab(s)`;
      loadedList.appendChild(li);
    }
    $('loaded-tip').classList.toggle('hidden', !(settings.inactivitySeconds > 30 || settings.customMode));
  }

  const memEl = $('memory-estimate');
  if (settings.showMemoryEstimate) {
    memEl.classList.remove('hidden');
    memEl.textContent =
      `Rough estimate (not measured): ~${(counts.unloaded ?? 0) * settings.estimateMBPerTab} MB ` +
      `(${settings.estimateMBPerTab} MB × ${counts.unloaded ?? 0} unloaded tabs). Chrome does not ` +
      `expose per-tab memory to extensions, so treat this as an approximation only.`;
  } else {
    memEl.classList.add('hidden');
  }

  // Current tab
  const badge = $('tab-badge');
  if (!currentTab) {
    badge.textContent = 'Unknown';
    badge.className = 'badge warn';
    $('tab-title').textContent = 'No active tab found';
    $('tab-url').textContent = '';
  } else {
    const desc = describeTab(currentTab, {
      settings,
      protectedIds: protectedSet(),
      loadedIds: loadedSet()
    });
    badge.textContent = desc.label;
    badge.className = `badge ${badgeClassFor(desc.state)}`;
    $('tab-title').textContent = currentTab.title || '(untitled)';
    $('tab-url').textContent = currentTab.url || '';
  }

  // Actions
  const unloadCurrent = $('unload-current');
  const switchAwayMode = Date.now() < switchAwayUntil;
  unloadCurrent.textContent = switchAwayMode
    ? 'Switch away \u0026 unload this tab'
    : 'Unload this tab';
  unloadCurrent.classList.toggle('danger', switchAwayMode);
  unloadCurrent.disabled =
    !currentTab || currentTab.discarded || isInternalUrl(currentTab?.url);

  const unloadAll = $('unload-all');
  const confirming = Date.now() < confirmAllUntil;
  unloadAll.textContent = confirming
    ? 'Confirm: unload them now'
    : 'Unload all eligible inactive tabs';
  unloadAll.classList.toggle('danger', confirming);
  unloadAll.disabled = (counts.unloadable ?? 0) === 0 && !confirming;

  const protectBtn = $('protect-current');
  const isProtected = currentTab ? protectedSet().has(currentTab.id) : false;
  const isExcluded = currentTab ? urlExcluded(currentTab.url, settings.exclusions) : false;
  protectBtn.disabled = !currentTab;
  protectBtn.textContent = isProtected
    ? 'Unprotect this tab'
    : isExcluded
      ? 'Unprotect (remove site rule)'
      : 'Protect this tab';

  const keepBtn = $('keep-loaded');
  keepBtn.disabled = !currentTab || isInternalUrl(currentTab?.url);
  keepBtn.textContent =
    settings.keepLoadedMode === 'permanent'
      ? 'Keep this tab loaded (always)'
      : 'Keep this tab loaded (session)';
}

function badgeClassFor(state) {
  switch (state) {
    case 'active':
    case 'loaded':
      return 'ok';
    case 'waiting':
      return 'accent';
    case 'protected':
    case 'excluded':
      return 'warn';
    case 'unloaded':
      return '';
    default:
      return 'err';
  }
}

/* ---------------- data ---------------- */

async function refresh() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = normalizeSettings(stored[SETTINGS_KEY]);
  snapshot = await send({ type: 'snapshot' });
  if (!snapshot?.ok) {
    feedback(snapshot?.message || 'Could not read extension state.', 'err');
    snapshot = null;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  currentTab = tab || null;
  render();
}

/* ---------------- events ---------------- */

$('startup-toggle').addEventListener('change', (e) => {
  void saveSettings({ loadActiveTabOnStartup: e.target.checked });
});

$('auto-toggle').addEventListener('change', (e) => {
  void saveSettings({ autoUnload: e.target.checked });
});

$('timeout-select').addEventListener('change', (e) => {
  const value = e.target.value;
  if (value === 'custom') {
    void saveSettings({ customMode: true });
    feedback('Custom timeout is edited in Settings.', 'info');
  } else {
    void saveSettings({ inactivitySeconds: Number(value), customMode: false });
  }
});

$('custom-edit').addEventListener('click', () => void chrome.runtime.openOptionsPage());

$('pause-btn').addEventListener('click', async () => {
  const res = await send({ type: 'togglePause' });
  if (res?.ok) {
    feedback(res.paused ? 'Automatic unloading paused for this session.' : 'Automatic unloading resumed.', 'info');
    if (snapshot) snapshot.paused = res.paused;
    render();
  } else {
    feedback(res?.message || 'Could not change pause state.', 'err');
  }
});

$('unload-current').addEventListener('click', async () => {
  const usingSwitchAway = Date.now() < switchAwayUntil;
  const res = await send({ type: 'unloadCurrent', switchAway: usingSwitchAway });
  if (!res?.ok && currentTab?.active && /currently in focus/.test(res?.message || '')) {
    // Chrome refuses to discard the focused tab — offer the explicit fallback.
    switchAwayUntil = Date.now() + 6000;
    feedback(
      'Chrome cannot unload the tab you are currently on. Click the button again to switch to the next tab and unload this one.',
      'info'
    );
    render();
    setTimeout(render, 6100);
    return;
  }
  switchAwayUntil = 0;
  feedback(res?.message || (res?.ok ? 'Tab unloaded.' : 'Could not unload the tab.'), res?.ok ? 'ok' : 'err');
  await refresh();
});

$('unload-all').addEventListener('click', async () => {
  if (Date.now() >= confirmAllUntil) {
    confirmAllUntil = Date.now() + 5000;
    feedback('Click again to confirm — eligible inactive tabs will be unloaded (never the active one).', 'info');
    render();
    setTimeout(render, 5100);
    return;
  }
  confirmAllUntil = 0;
  const res = await send({ type: 'unloadAll' });
  if (res?.ok) {
    feedback(`${res.discarded} tab(s) unloaded · ${res.failed} could not be unloaded.`, res.failed ? 'info' : 'ok');
  } else {
    feedback(res?.message || 'Unload-all failed.', 'err');
  }
  await refresh();
});

$('protect-current').addEventListener('click', async () => {
  if (!currentTab) return;
  if (protectedSet().has(currentTab.id)) {
    const res = await send({ type: 'setProtected', tabId: currentTab.id, value: false });
    feedback(res?.ok ? 'Tab unprotected — normal rules apply again.' : res?.message, res?.ok ? 'ok' : 'err');
  } else if (urlExcluded(currentTab.url, settings.exclusions)) {
    const res = await send({ type: 'removeSiteRule', tabId: currentTab.id });
    feedback(res?.message || 'Done.', res?.ok ? 'ok' : 'err');
  } else {
    const res = await send({ type: 'setProtected', tabId: currentTab.id, value: true });
    feedback(res?.ok ? 'Tab protected from automatic unloading.' : res?.message, res?.ok ? 'ok' : 'err');
  }
  await refresh();
});

$('keep-loaded').addEventListener('click', async () => {
  if (!currentTab) return;
  const res = await send({ type: 'keepLoaded', tabId: currentTab.id });
  feedback(res?.message || (res?.ok ? 'Tab kept loaded.' : 'Could not update protection.'), res?.ok ? 'ok' : 'err');
  await refresh();
});

$('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());

$('copy-diagnostics').addEventListener('click', async () => {
  await refresh(); // make sure the snapshot is current
  const desc = currentTab
    ? describeTab(currentTab, { settings, protectedIds: protectedSet(), loadedIds: loadedSet() })
    : null;
  const text = [
    `TabUnloader diagnostics — ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `Settings: ${JSON.stringify(settings)}`,
    `Paused: ${Boolean(snapshot?.paused)}`,
    `Session stats (auto/manual/failed): ${JSON.stringify(snapshot?.stats)}`,
    `Counts: ${JSON.stringify(snapshot?.counts)}`,
    `Startup gate active: ${Boolean(snapshot?.startupActive)}`,
    `Protected tab ids: ${JSON.stringify(snapshot?.protectedIds || [])}`,
    `Current tab: ${currentTab ? JSON.stringify({ id: currentTab.id, url: currentTab.url, active: currentTab.active, discarded: currentTab.discarded, pinned: currentTab.pinned, audible: currentTab.audible }) : 'none'} → ${desc ? desc.label : 'n/a'}`
  ].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    feedback('Diagnostics copied to the clipboard — paste it where you need help.', 'ok');
  } catch (err) {
    feedback(`Could not copy diagnostics: ${err?.message || err}`, 'err');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    render();
  }
});

void refresh();
