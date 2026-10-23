/**
 * Unit tests for TabUnloader's shared logic (common.js).
 * Run: node tools/selftest.mjs
 */
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  effectiveTimeoutSeconds,
  formatTimeout,
  validatePattern,
  normalizePattern,
  hostnameMatches,
  urlExcluded,
  isInternalUrl,
  describeTab,
  autoEligible
} from '../common.js';

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

/* settings */
check('defaults', normalizeSettings(null).inactivitySeconds, 300);
check('default timeout is 5 minutes', effectiveTimeoutSeconds(normalizeSettings(null)), 300);
check('custom mode wins', effectiveTimeoutSeconds(normalizeSettings({ customMode: true, customSeconds: 45 })), 45);
check('never = 0', normalizeSettings({ inactivitySeconds: 0 }).inactivitySeconds, 0);
check('invalid timeout clamped to default', normalizeSettings({ inactivitySeconds: -5 }).inactivitySeconds, 300);
check('garbage input safe', normalizeSettings('nonsense').autoUnload, true);
check('exclusions deduped+normalized', normalizeSettings({ exclusions: ['Mail.Google.com', 'mail.google.com', '*.x.com'] }).exclusions, ['mail.google.com', '*.x.com']);
check('bad exclusions dropped', normalizeSettings({ exclusions: ['has space.com', 'ok.com/path'] }).exclusions, []);
check('formatTimeout 5m', formatTimeout(300), '5 minutes');
check('formatTimeout never', formatTimeout(0), 'Never');
check('formatTimeout 1h', formatTimeout(3600), '1 hour');

/* patterns */
check('valid plain host', validatePattern('mail.google.com').ok, true);
check('valid wildcard', normalizePattern('*.example.com'), '*.example.com');
check('scheme stripped', normalizePattern('https://Mail.Google.com'), 'mail.google.com');
check('port ignored', normalizePattern('localhost:3000'), 'localhost');
check('path rejected', validatePattern('example.com/page').ok, false);
check('spaces rejected', validatePattern('a b.com').ok, false);
check('empty rejected', validatePattern('   ').ok, false);
check('match exact', hostnameMatches('mail.google.com', 'mail.google.com'), true);
check('no subdomain of exact', hostnameMatches('mail.google.com', 'www.mail.google.com'), false);
check('wildcard apex', hostnameMatches('*.example.com', 'example.com'), true);
check('wildcard subdomain', hostnameMatches('*.example.com', 'a.b.example.com'), true);
check('wildcard non-match', hostnameMatches('*.example.com', 'notexample.com'), false);
check('url excluded', urlExcluded('https://mail.google.com/mail/u/0', ['mail.google.com']), true);
check('url not excluded', urlExcluded('https://example.org', ['mail.google.com']), false);
check('internal chrome url', isInternalUrl('chrome://extensions'), true);
check('internal newtab', isInternalUrl('chrome://newtab/'), true);
check('https not internal', isInternalUrl('https://example.com'), false);
check('empty url internal', isInternalUrl(''), true);

/* tab classification */
const base = { id: 7, url: 'https://site.com/x', active: false, discarded: false, audible: false, pinned: false };
const ctx = { settings: normalizeSettings(null), protectedIds: new Set(), loadedIds: new Set([7]) };

check('desc discarded+loaded', describeTab({ ...base, discarded: true }, ctx).state, 'unloaded');
check('desc discarded+never-loaded', describeTab({ ...base, discarded: true }, { ...ctx, loadedIds: new Set() }).state, 'waiting');
check('desc active', describeTab({ ...base, active: true }, ctx).state, 'active');
check('desc protected', describeTab(base, { ...ctx, protectedIds: new Set([7]) }).state, 'protected');
check('desc excluded', describeTab(base, { ...ctx, settings: normalizeSettings({ exclusions: ['site.com'] }) }).state, 'excluded');
check('desc internal', describeTab({ ...base, url: 'chrome://settings' }, ctx).state, 'internal');
check('desc plain loaded', describeTab(base, ctx).state, 'loaded');
check('desc pinned protected', describeTab({ ...base, pinned: true }, ctx).state, 'protected');
check('desc audio protected', describeTab({ ...base, audible: true }, ctx).state, 'protected');
check('desc auto-off', describeTab(base, { ...ctx, settings: normalizeSettings({ autoUnload: false }) }).state, 'auto-off');

/* eligibility */
check('active ineligible', autoEligible({ ...base, active: true }, ctx).reason, 'active-or-already-unloaded');
check('discarded ineligible', autoEligible({ ...base, discarded: true }, ctx).reason, 'active-or-already-unloaded');
check('internal ineligible', autoEligible({ ...base, url: 'chrome://bookmarks' }, ctx).reason, 'cannot-be-discarded');
check('protected ineligible', autoEligible(base, { ...ctx, protectedIds: new Set([7]) }).reason, 'protected-by-user');
check('excluded ineligible', autoEligible(base, { ...ctx, settings: normalizeSettings({ exclusions: ['site.com'] }) }).reason, 'excluded-by-rules');
check('paused ineligible', autoEligible(base, { ...ctx, paused: true }).reason, 'paused');
check('never ineligible', autoEligible(base, { ...ctx, settings: normalizeSettings({ inactivitySeconds: 0 }) }).reason, 'timeout-never');
check('plain tab eligible', autoEligible(base, ctx).ok, true);
check('unpinned ok when protectPinned off', autoEligible({ ...base, pinned: true }, { ...ctx, settings: normalizeSettings({ protectPinned: false }) }).ok, true);

/* default settings sanity */
check('default exclusions empty', DEFAULT_SETTINGS.exclusions.length, 0);
check('default startup protection on', DEFAULT_SETTINGS.startupProtection, true);
check('default group load guard on', DEFAULT_SETTINGS.groupTabGuard, true);
check('group guard normalizes truthy/garbage', [normalizeSettings({ groupTabGuard: false }).groupTabGuard, normalizeSettings('x').groupTabGuard], [false, true]);
check('default load-active-on-startup off', DEFAULT_SETTINGS.loadActiveTabOnStartup, false);

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll self-tests passed.');
