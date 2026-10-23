/**
 * Static validation for TabUnloader:
 *  - `node --check` (ESM parse) on every JS file
 *  - manifest.json structure sanity checks
 * Run: node tools/check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function fail(msg) {
  failures += 1;
  console.error('FAIL:', msg);
}

/* --- JS syntax --- */
const jsFiles = [
  ...readdirSync(ROOT).filter((f) => f.endsWith('.js')),
  ...readdirSync(join(ROOT, 'tools')).filter((f) => f.endsWith('.mjs')).map((f) => `tools/${f}`)
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' });
    console.log('ok   syntax', file);
  } catch (err) {
    fail(`syntax error in ${file}\n${err.stderr}`);
  }
}

/* --- manifest --- */
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const checks = [
    [manifest.manifest_version === 3, 'manifest_version must be 3'],
    [typeof manifest.background?.service_worker === 'string', 'background.service_worker missing'],
    [manifest.background?.type === 'module', 'background type must be module'],
    [Array.isArray(manifest.permissions), 'permissions must be an array'],
    [!manifest.host_permissions, 'host_permissions must not be requested'],
    [!manifest.content_scripts, 'no content_scripts expected'],
    [typeof manifest.action?.default_popup === 'string', 'action.default_popup missing'],
    [typeof manifest.options_page === 'string', 'options_page missing'],
    [Array.isArray(manifest.icons) === false && manifest.icons && typeof manifest.icons === 'object', 'icons missing']
  ];
  for (const [ok, msg] of checks) if (!ok) fail(msg);

  const perms = new Set(manifest.permissions);
  for (const p of perms) {
    if (!['tabs', 'storage', 'alarms'].includes(p)) fail(`unexpected permission: ${p}`);
  }
  for (const icon of Object.values(manifest.icons || {})) {
    try {
      const buf = readFileSync(join(ROOT, icon));
      const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (!isPng) fail(`icon is not a PNG: ${icon}`);
    } catch {
      fail(`icon file missing: ${icon}`);
    }
  }
  console.log('ok   manifest validated');
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
}

/* --- forbidden API guard: the extension must never close tabs --- */
for (const file of ['service-worker.js', 'popup.js', 'options.js']) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  if (/tabs\.remove/.test(src)) fail(`${file} references tabs.remove (tabs must never be closed)`);
}
console.log('ok   no tabs.remove usage');

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed.');
