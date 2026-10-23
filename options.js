/**
 * TabUnloader — options page controller.
 * Every change is normalized, saved to chrome.storage.local, and picked up by
 * the service worker through chrome.storage.onChanged (no restart required).
 */

import {
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  normalizeSettings,
  applyTheme,
  validatePattern,
  normalizePattern,
  TIMEOUT_PRESETS
} from './common.js';

const $ = (id) => document.getElementById(id);

let settings = normalizeSettings(null);
let saveFlashTimer = null;

function flashSaved() {
  const el = $('save-indicator');
  el.textContent = 'Saved ✓';
  el.className = 'badge ok';
  clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(() => {
    el.textContent = '';
    el.className = 'badge';
  }, 1800);
}

async function persist(patch) {
  settings = normalizeSettings({ ...settings, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  applyTheme(settings.theme);
  renderExclusions();
  flashSaved();
}

/* ---------------- rendering ---------------- */

function render() {
  applyTheme(settings.theme);

  $('autoUnload').checked = settings.autoUnload;
  const isPreset = TIMEOUT_PRESETS.includes(settings.inactivitySeconds);
  $('timeoutPreset').value = settings.customMode || !isPreset ? 'custom' : String(settings.inactivitySeconds);
  $('customSeconds').value = settings.customSeconds;
  $('customField').classList.toggle('hidden', $('timeoutPreset').value !== 'custom');

  $('startupProtection').checked = settings.startupProtection;
  $('loadActiveTabOnStartup').checked = settings.loadActiveTabOnStartup;
  $('loadActiveTabOnStartup').disabled = !settings.startupProtection;
  $('groupTabGuard').checked = settings.groupTabGuard;
  $('protectPinned').checked = settings.protectPinned;
  $('protectAudio').checked = settings.protectAudio;
  for (const radio of document.getElementsByName('keepLoadedMode')) {
    radio.checked = radio.value === settings.keepLoadedMode;
  }

  $('theme').value = settings.theme;
  $('showMemoryEstimate').checked = settings.showMemoryEstimate;
  $('estimateMBPerTab').value = settings.estimateMBPerTab;
  $('estimateMBPerTab').disabled = !settings.showMemoryEstimate;

  renderExclusions();
}

function renderExclusions() {
  const list = $('exclusionList');
  list.textContent = '';
  if (settings.exclusions.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No exclusions yet. Examples: mail.google.com, meet.google.com, docs.google.com, localhost, *.example.com';
    list.appendChild(li);
    return;
  }
  for (const pattern of settings.exclusions) {
    const li = document.createElement('li');
    li.className = 'chip';
    const span = document.createElement('span');
    span.textContent = pattern;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Remove ${pattern}`;
    remove.setAttribute('aria-label', `Remove ${pattern}`);
    remove.addEventListener('click', () => {
      void persist({ exclusions: settings.exclusions.filter((p) => p !== pattern) });
    });
    li.append(span, remove);
    list.appendChild(li);
  }
}

/* ---------------- events ---------------- */

$('autoUnload').addEventListener('change', (e) => void persist({ autoUnload: e.target.checked }));

$('timeoutPreset').addEventListener('change', (e) => {
  const value = e.target.value;
  $('customField').classList.toggle('hidden', value !== 'custom');
  if (value === 'custom') {
    void persist({ customMode: true });
  } else {
    void persist({ inactivitySeconds: Number(value), customMode: false });
  }
});

$('customSeconds').addEventListener('change', (e) => {
  const value = Math.min(604800, Math.max(10, Math.round(Number(e.target.value) || 420)));
  e.target.value = value;
  void persist({ customSeconds: value, customMode: true });
});

$('startupProtection').addEventListener('change', (e) => {
  $('loadActiveTabOnStartup').disabled = !e.target.checked;
  void persist({ startupProtection: e.target.checked });
});

$('loadActiveTabOnStartup').addEventListener('change', (e) =>
  void persist({ loadActiveTabOnStartup: e.target.checked })
);

$('groupTabGuard').addEventListener('change', (e) => void persist({ groupTabGuard: e.target.checked }));

$('protectPinned').addEventListener('change', (e) => void persist({ protectPinned: e.target.checked }));
$('protectAudio').addEventListener('change', (e) => void persist({ protectAudio: e.target.checked }));

for (const radio of document.getElementsByName('keepLoadedMode')) {
  radio.addEventListener('change', (e) => {
    if (e.target.checked) void persist({ keepLoadedMode: e.target.value });
  });
}

function addExclusion() {
  const input = $('exclusionInput');
  const errorEl = $('exclusionError');
  const raw = input.value;
  const check = validatePattern(raw);
  if (!check.ok) {
    errorEl.textContent = check.error;
    return;
  }
  const normalized = normalizePattern(raw);
  if (settings.exclusions.includes(normalized)) {
    errorEl.textContent = 'This pattern is already in the list.';
    return;
  }
  errorEl.textContent = '';
  input.value = '';
  void persist({ exclusions: [...settings.exclusions, normalized] });
}

$('addExclusion').addEventListener('click', addExclusion);
$('exclusionInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addExclusion();
});
$('exclusionInput').addEventListener('input', () => {
  $('exclusionError').textContent = '';
});

$('theme').addEventListener('change', (e) => void persist({ theme: e.target.value }));

$('showMemoryEstimate').addEventListener('change', (e) => {
  $('estimateMBPerTab').disabled = !e.target.checked;
  void persist({ showMemoryEstimate: e.target.checked });
});

$('estimateMBPerTab').addEventListener('change', (e) => {
  const value = Math.min(4096, Math.max(1, Math.round(Number(e.target.value) || 100)));
  e.target.value = value;
  void persist({ estimateMBPerTab: value });
});

$('resetSettings').addEventListener('click', () => {
  if (!window.confirm('Reset all TabUnloader settings to their defaults?')) return;
  void persist({ ...DEFAULT_SETTINGS });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    render();
  }
});

/* ---------------- init ---------------- */

(async () => {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settings = normalizeSettings(stored[SETTINGS_KEY]);
  if (!stored[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } });
  }
  render();
})();
