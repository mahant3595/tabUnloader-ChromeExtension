/**
 * TabUnloader — shared module (settings, URL rules, tab classification).
 * Loaded by the service worker (module), popup and options pages (module).
 *
 * This file must not reference any chrome.* API at import time so it can also
 * be loaded by the Node-based self-tests in tools/selftest.mjs.
 */

export const SETTINGS_KEY = 'settings';

export const TIMEOUT_PRESETS = [30, 60, 120, 300, 600, 900, 1800, 3600, 0];

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  // Automatic inactivity unloading master switch.
  autoUnload: true,
  // Seconds of inactivity before a loaded inactive tab is discarded. 0 = never.
  inactivitySeconds: 300,
  // Custom timeout (seconds) kept so the UI can restore a user-typed value.
  customSeconds: 420,
  // True when the user selected "Custom" in the timeout dropdown.
  customMode: false,
  // Startup protection subsystem (independent from autoUnload).
  startupProtection: true,
  // Chrome eagerly loads every tab inside a tab group when the group is
  // opened. Re-unload the background members the user never activated.
  groupTabGuard: true,
  // OFF by default: keep restored tabs — including the initially selected one —
  // unloaded until the user activates them (as far as Chrome permits).
  loadActiveTabOnStartup: false,
  protectPinned: true,
  protectAudio: true,
  // 'temporary' → "Keep This Tab Loaded" protects the tab for this session.
  // 'permanent' → adds the tab's site to the exclusion list instead.
  keepLoadedMode: 'temporary',
  // Hostname patterns that must never be unloaded automatically.
  exclusions: [],
  theme: 'system', // 'system' | 'light' | 'dark'
  // Optional rough memory estimate (clearly labelled as an estimate).
  showMemoryEstimate: false,
  estimateMBPerTab: 100
});

const NUM = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** Coerce arbitrary stored data into a complete, valid settings object. */
export function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };

  s.autoUnload = Boolean(s.autoUnload);
  s.startupProtection = Boolean(s.startupProtection);
  s.groupTabGuard = Boolean(s.groupTabGuard);
  s.loadActiveTabOnStartup = Boolean(s.loadActiveTabOnStartup);
  s.protectPinned = Boolean(s.protectPinned);
  s.protectAudio = Boolean(s.protectAudio);
  s.customMode = Boolean(s.customMode);
  s.showMemoryEstimate = Boolean(s.showMemoryEstimate);

  // 0 means "Never automatically unload". Negative/garbage values fall back
  // to the default instead of silently disabling unloading.
  const rawTimeout = Number(s.inactivitySeconds);
  s.inactivitySeconds = TIMEOUT_PRESETS.includes(rawTimeout)
    ? rawTimeout
    : rawTimeout > 0
      ? NUM(rawTimeout, 1, 604800, DEFAULT_SETTINGS.inactivitySeconds)
      : DEFAULT_SETTINGS.inactivitySeconds;
  s.customSeconds = NUM(s.customSeconds, 10, 604800, DEFAULT_SETTINGS.customSeconds);
  s.estimateMBPerTab = NUM(s.estimateMBPerTab, 1, 4096, DEFAULT_SETTINGS.estimateMBPerTab);

  s.keepLoadedMode = s.keepLoadedMode === 'permanent' ? 'permanent' : 'temporary';
  s.theme = ['system', 'light', 'dark'].includes(s.theme) ? s.theme : 'system';

  const list = Array.isArray(s.exclusions) ? s.exclusions : [];
  const seen = new Set();
  s.exclusions = [];
  for (const entry of list) {
    const normalized = normalizePattern(entry); // keeps "*.host" wildcard semantics
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      s.exclusions.push(normalized);
    }
  }
  return s;
}

/** Apply a stored theme to the current document ('system' defers to CSS media queries). */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** The timeout currently in effect (seconds); 0 = never. */
export function effectiveTimeoutSeconds(settings) {
  if (settings.customMode) return settings.customSeconds;
  return settings.inactivitySeconds;
}

export function formatTimeout(seconds) {
  if (!seconds) return 'Never';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const m = seconds / 60;
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const h = seconds / 3600;
  return `${h} hour${h === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * URL / pattern helpers
 * ------------------------------------------------------------------ */

const INTERNAL_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:',
  'about:', 'devtools:', 'edge:', 'brave:', 'resources:', 'view-source:'
]);

export function safeUrl(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/** true for pages Chrome will not let an extension discard (browser internals). */
export function isInternalUrl(rawUrl) {
  if (!rawUrl) return true; // empty/uncommitted URL → treat as non-discardable
  const u = safeUrl(rawUrl);
  if (!u) return true;
  return INTERNAL_PROTOCOLS.has(u.protocol);
}

export function hostnameOf(rawUrl) {
  const u = safeUrl(rawUrl);
  return u ? u.hostname.toLowerCase() : '';
}

/**
 * Validate a user-entered exclusion pattern.
 * Accepted: "mail.google.com", "*.example.com", "localhost",
 * "https://mail.google.com" (scheme stripped), optional port (ignored).
 * Rejected: paths, spaces, empty values, invalid host characters.
 * Returns { ok, normalized, error }.
 */
export function validatePattern(input) {
  const original = String(input ?? '').trim();
  if (!original) return { ok: false, error: 'Pattern is empty.' };
  if (/\s/.test(original)) return { ok: false, error: 'Patterns cannot contain spaces.' };

  let value = original.toLowerCase();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(value);
  if (withScheme) {
    const u = safeUrl(value);
    if (!u) return { ok: false, error: 'Not a valid URL.' };
    if (u.pathname !== '/' || u.search || u.hash) {
      return { ok: false, error: 'Enter a hostname only — remove any path, query or #fragment.' };
    }
    value = u.host; // hostname (+port)
  }
  if (value.includes('/')) {
    return { ok: false, error: 'Enter a hostname only — remove any path (e.g. "site.com/page").' };
  }
  // Ignore an explicit port so the rule matches the site on any port.
  value = value.replace(/:\d+$/, '');
  if (value.startsWith('*.')) value = value.slice(2);
  if (!value) return { ok: false, error: 'Pattern has no hostname.' };
  if (!/^[a-z0-9.-]+$/.test(value) || value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    return { ok: false, error: 'Use only letters, digits, dots and dashes (optionally prefixed with "*.").' };
  }
  return { ok: true, normalized: value, input: original };
}

/**
 * A stored pattern is always normalized to a bare hostname, or "*.host"
 * semantics are re-derived from the original input. To keep "*.example.com"
 * distinguishable we prefix stored wildcard patterns with "*.".
 */
export function normalizePattern(input) {
  const v = validatePattern(input);
  if (!v.ok) return null;
  const wantedWildcard = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/:\d+$/, '').startsWith('*.');
  return wantedWildcard && !v.normalized.startsWith('*.') ? `*.${v.normalized}` : v.normalized;
}

/** Does `hostname` match `pattern` ("host", "*.host", or "" )? */
export function hostnameMatches(pattern, hostname) {
  if (!pattern || !hostname) return false;
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === p;
}

/** true when the tab's URL matches any configured exclusion pattern. */
export function urlExcluded(rawUrl, exclusions) {
  if (!Array.isArray(exclusions) || exclusions.length === 0) return false;
  const host = hostnameOf(rawUrl);
  if (!host) return false; // browser-internal pages are handled separately
  return exclusions.some((p) => hostnameMatches(p, host));
}

/* ------------------------------------------------------------------ *
 * Tab classification
 * ------------------------------------------------------------------ */

/**
 * ctx: { settings, protectedIds:Set<number>, loadedIds:Set<number>, paused:boolean }
 * Returns { state, label, note } where state is one of:
 *   waiting | unloaded | active | protected | excluded | internal |
 *   auto-off | loaded
 */
export function describeTab(tab, ctx) {
  const { settings, protectedIds = new Set(), loadedIds = new Set() } = ctx || {};
  const s = settings || DEFAULT_SETTINGS;

  if (tab.discarded) {
    if (!loadedIds.has(tab.id)) return { state: 'waiting', label: 'Waiting for activation' };
    return { state: 'unloaded', label: 'Unloaded' };
  }
  if (tab.active) return { state: 'active', label: 'Active and loaded' };
  if (isInternalUrl(tab.url)) return { state: 'internal', label: 'Cannot be discarded' };
  if (protectedIds.has(tab.id)) return { state: 'protected', label: 'Protected' };
  if (urlExcluded(tab.url, s.exclusions)) return { state: 'excluded', label: 'Excluded by rules' };
  if (s.protectPinned && tab.pinned) return { state: 'protected', label: 'Protected (pinned)' };
  if (s.protectAudio && tab.audible) return { state: 'protected', label: 'Protected (audio)' };
  if (!s.autoUnload) return { state: 'auto-off', label: 'Loaded (auto-unload off)' };
  return { state: 'loaded', label: 'Loaded' };
}

/**
 * Full automatic-discard policy for a tab (used by the service worker and the
 * popup's "Unload all eligible" preview). Never allows discarding an active,
 * already-discarded, internal, protected, excluded, or policy-shielded tab.
 * ctx: { settings, protectedIds, paused }
 */
export function autoEligible(tab, ctx) {
  const { settings, protectedIds = new Set(), paused = false } = ctx || {};
  const s = settings || DEFAULT_SETTINGS;

  if (!tab || tab.active || tab.discarded) return { ok: false, reason: 'active-or-already-unloaded' };
  if (isInternalUrl(tab.url)) return { ok: false, reason: 'cannot-be-discarded' };
  if (protectedIds.has(tab.id)) return { ok: false, reason: 'protected-by-user' };
  if (urlExcluded(tab.url, s.exclusions)) return { ok: false, reason: 'excluded-by-rules' };
  if (s.protectPinned && tab.pinned) return { ok: false, reason: 'pinned' };
  if (s.protectAudio && tab.audible) return { ok: false, reason: 'playing-audio' };
  if (paused) return { ok: false, reason: 'paused' };
  if (!s.autoUnload) return { ok: false, reason: 'auto-unload-disabled' };
  if (effectiveTimeoutSeconds(s) === 0) return { ok: false, reason: 'timeout-never' };
  return { ok: true };
}
