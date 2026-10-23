# Task: Implement the "Tab Unloader" feature set in this tab-storage project

You are working in a NEW project (my tab storage Chrome extension). Port the tab-unloading
feature from my existing project **TabUnloader**, which lives on this machine at:

- Windows path: `D:\chromeExtension\tabUnloader`
- Git-Bash path: `/d/chromeExtension/tabUnloader`

**Read those files directly — they are the authoritative reference and pass all tests:**

| File | What it contains |
| --- | --- |
| `D:\chromeExtension\tabUnloader\service-worker.js` | The whole engine (~810 lines, MV3 service worker): startup gate, 30-second alarm sweep, inactivity discard, **tab-group load guard**, manual unload with switch-away consent, and the runtime message API for the popup. |
| `D:\chromeExtension\tabUnloader\common.js` | Shared module used by worker + popup + options + Node tests: settings schema with `normalizeSettings()` coercion, hostname/exclusion pattern matching (`*.example.com` semantics), and `autoEligible()` tab classification. Must not touch `chrome.*` at import time. |
| `D:\chromeExtension\tabUnloader\popup.html` / `popup.js` / `popup.css` | Dashboard popup: counts, startup badge, "Still loaded" per-tab reason list, current-tab card, manual actions, "Copy diagnostics" button. |
| `D:\chromeExtension\tabUnloader\options.html` / `options.js` | Settings page (all toggles persist via `chrome.storage.local`, applied immediately). |
| `D:\chromeExtension\tabUnloader\manifest.json` | MV3 manifest. Permissions: `tabs`, `storage`, `alarms`. No host permissions needed. |
| `D:\chromeExtension\tabUnloader\tools\simulate.mjs` | Simulation harness: loads the REAL service worker against a mock `chrome.*` API with a controllable clock; 11 scenarios / 44 assertions. **Copy this testing pattern.** |
| `D:\chromeExtension\tabUnloader\tools\selftest.mjs` | 52 unit tests for settings normalization, pattern matching, tab classification. |
| `D:\chromeExtension\tabUnloader\tools\check.mjs` | ESM syntax check on every JS file + manifest validation + a guard forbidding `tabs.remove`. |
| `D:\chromeExtension\tabUnloader\README.md` | Full behavior spec, known Chrome limitations, manual acceptance-test guide. |

## Feature spec (behavior to replicate)

1. **Inactivity unloading** — one recurring `chrome.alarms` sweep (30 s period, the Chrome
   minimum). Loaded, inactive, eligible tabs are discarded after a configurable timeout
   (default 5 min; presets 30 s … 1 h, Custom, Never). Never close tabs — the ONLY
   unloading mechanism is `chrome.tabs.discard()`.
2. **Startup protection** — on `chrome.runtime.onStartup`, collect session-restored tabs
   into a guarded set and keep them discarded until the user activates them. 3-minute
   candidate-collection window; retry on every fresh page load of a guarded tab; max 3
   attempts per navigation; a fresh load resets the attempt budget (Chrome re-navigates
   restored tabs after session restore).
3. **Tab-group load guard (default ON)** — Chrome eagerly loads EVERY tab in a group when
   the group is opened; there is no API to stop the loads, so re-unload them. When
   `tabs.onUpdated` reports a load of a tab that satisfies ALL of:
   - `tab.groupId > 0` (grouped; `-1` = ungrouped),
   - not active, not already discarded,
   - never activated by the user this session,
   - no `openerTabId` (a tab with an opener was deliberately opened by the user — skip),
   - not startup-guarded (the startup gate owns those), not internal URL, passes protections,

   …discard it immediately, and retry at `status: 'complete'` because Chrome refuses
   discards while a load is in flight. Give each navigation a fresh attempt budget.
4. **Protections (never auto-discard):** active tab of any window, pinned tabs (setting),
   audible tabs (setting), per-tab session protection ("Keep this tab loaded"), per-host
   exclusion patterns, `chrome://` and other internal pages.
5. **Manual controls** (runtime messages from popup):
   - `unloadCurrent` — Chrome refuses to discard the FOCUSED tab (the popup's tab always
     is). First attempt fails with an explanation; the popup then offers "Switch away &
     unload this tab" for 6 s; on the consented second click the worker activates the
     neighbouring tab (`tabs.update`) and then discards the original.
   - `unloadAll` — bulk discard of all policy-eligible inactive tabs; returns
     `{ discarded, failed }`.
   - `keepLoaded` — session protection or permanent host exclusion (user setting).
   - `setProtected`, `togglePause`/`setPaused`, `getSettings`, `snapshot` (counts,
     per-tab "still loaded" reasons, session stats including failed attempts,
     protected ids, startup activity).
6. **State & settings** — settings in `chrome.storage.local` (always passed through
   `normalizeSettings()` so garbage/partial data is safe); runtime state in
   `chrome.storage.session` (survives service-worker suspension), flushed debounced.

## Chrome API facts discovered the hard way (do not rediscover)

- `chrome.tabs.discard()` silently resolves `undefined` (refusal) for: the focused tab,
  the active tab of any window, internal URLs, and **while a navigation is in flight**.
- `chrome.alarms` minimum period for packaged extensions is 30 s — no faster scheduled work.
- Chrome starts loading session-restored pages BEFORE any extension service worker can
  run; no supported API can pause or cancel those first requests. Documented limitation,
  not a bug — reclaim the memory afterwards instead.
- Opening/expanding a tab group makes Chrome load all its tabs natively. An extension can
  only re-unload them afterwards (the group load guard). No Chrome setting prevents it.
- `tab.groupId` is available with the plain `tabs` permission (`-1` = ungrouped); the
  `tabGroups` permission is NOT needed just to read it.
- There is NO discard/freeze event in the API — treat `tab.discarded` as ground truth on
  every sweep instead.
- Tabs with an `openerTabId` were opened deliberately by the user (middle-click /
  `target=_blank`) — never aggressively unload those.
- The initially selected restored tab is always loaded by Chrome before extensions can
  act; it is discarded only after the user switches away.

## Acceptance criteria

- All of the above implemented in THIS project's own files, adapted to its structure and
  naming (don't just copy files blindly — integrate).
- A simulation harness following the `tools/simulate.mjs` pattern (mock `chrome.*` +
  controllable `Date.now`) covering at least: startup discard, user-activation reload,
  inactivity timing, **group guard** (background group member unloaded; previously-used,
  opener-carrying, active, and non-group tabs untouched; guard-off restores stock
  behavior), focused-tab refusal + switch-away flow.
- Unit tests for settings normalization and exclusion pattern matching.
- `npm run check && npm run selftest && npm run simulate` (or the project's equivalent)
  all exit 0; preserve exit status when piping.
- No `tabs.remove` anywhere; no long-lived timers or polling — event-driven + alarms only.

Start by reading the reference files above, then integrate into this project.
