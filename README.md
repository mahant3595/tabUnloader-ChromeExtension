# TabUnloader — Smart Tab & Memory Manager

A Chrome extension (Manifest V3) that reduces Chrome's memory usage by **keeping every tab
open but loading a page only when you open it**, and by automatically unloading tabs after a
configurable period of inactivity.

**Core promise:** tabs are never closed. TabUnloader only *discards* pages with Chrome's
supported API (`chrome.tabs.discard`). A discarded tab stays visible in the tab strip with its
original URL; its page reloads the moment you activate it again.

> ⚠️ Discarding frees memory but throws away the page's in-memory state: unsaved form input,
> in-progress uploads, or running web-app sessions may be lost when the page reloads.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Installing (unpacked)](#installing-unpacked)
3. [Using TabUnloader](#using-tabunloader)
4. [Settings reference](#settings-reference)
5. [Known Chrome API limitations](#known-chrome-api-limitations)
6. [Testing guide](#testing-guide)
7. [Troubleshooting](#troubleshooting)
8. [Packaging for the Chrome Web Store](#packaging-for-the-chrome-web-store)
9. [Project structure & development](#project-structure--development)
10. [Privacy](#privacy)

---

## How it works

### Architecture

| File | Role |
| --- | --- |
| `service-worker.js` | MV3 service worker: startup gate, inactivity sweeps, discarding, stats, messaging |
| `common.js` | Shared settings schema, URL-pattern matching, tab classification |
| `popup.html/css/js` | Toolbar popup: status, dashboard, manual controls |
| `options.html/css/js` | Full settings page incl. exclusion manager, theme, privacy |
| `common.css` | Shared light/dark theme and components |
| `icons/` | PNG icons (16/32/48/128) |
| `tools/` | Optional Node dev tooling (syntax checks, self-tests, icon generator) |

All tab work is **event-driven**, plus a single `chrome.alarms` sweep every 30 seconds
(Chrome's minimum alarm period for packaged extensions). There are no persistent loops, no
sub-second polling, and the sweep exits *without even querying tabs* when there is nothing to
do. The dashboard uses `chrome.tabs.query` (pure metadata — it never triggers page loads).

State lives in two places:

- `chrome.storage.local` — user settings (survive restarts).
- `chrome.storage.session` — per-browser-session runtime state: which tabs the user
  activated, which tabs were restored at startup, per-tab inactivity timestamps, protection
  flags, and session statistics. It survives service-worker suspension but is cleared on
  browser restart, so stale tab IDs are never carried across sessions.

### Startup protection (Scenario A)

Chrome's `runtime.onStartup` fires when the profile starts. TabUnloader then:

1. Snapshots every open tab as a *restored candidate* (tabs with an opener tab, i.e. tabs the
   user created, are excluded; so is any tab the user activates).
2. Immediately discards every candidate that Chrome permits discarding.
3. Keeps guarding the candidates for the next 3 minutes, because Chrome's session restore
   lazy-loads restored tabs over time. Whenever a candidate starts loading in the background
   (`tabs.onUpdated` status `loading`), it is discarded right away — up to 3 attempts per
   page load, with an 8-second cooldown, so it can never loop. If Chrome refuses discards
   while a load is in flight (which can happen during session restore) and later re-navigates
   the tab, the next load gets a fresh attempt budget, so the tab cannot stay loaded forever.
4. If **Load active tab automatically on startup** is OFF (default), even the initially
   selected tab is discarded at the first opportunity after you switch away from it — Chrome
   itself always loads the initially selected tab first and never allows an extension to
   discard the focused tab, so this is the strongest enforceable behavior. See
   [limitations](#known-chrome-api-limitations).

Excluded sites and protected/pinned/audio tabs are respected by the startup gate too.

### Opening one tab (Scenario B)

Discarded tabs reload purely through Chrome's native behavior when you click them. The
extension does not call navigation APIs at all — activating a tab only marks it as
"user-activated", after which normal inactivity rules apply. Nothing else is loaded.

### Inactivity unloading (Scenario C)

- `tabs.onActivated` records the moment a tab becomes inactive and clears its timer when it
  becomes active again; `windows.onFocusChanged` handles cross-window switches.
- The 30-second sweep discards any loaded, inactive, eligible tab whose inactivity exceeds
  the timeout (default **5 minutes**). The active tab of any window is never touched.
- Changing the timeout takes effect on the next sweep (usually ≤ 30 s) — eligibility is
  recomputed from the *actual* inactivity timestamps, so shortening the timeout can unload
  tabs immediately, and lengthening it never causes premature unloading.

### Manual controls & protection

The popup can: unload the current tab (with an honest explanation when Chrome refuses),
unload all eligible inactive tabs (with confirmation and exact success/failure counts),
protect/unprotect a tab, apply "Keep This Tab Loaded" (session or permanent, per your
setting), pause automatic unloading for the session, and view per-tab status. Startup
protection is independent: pausing or disabling automatic unloading never disables it.

---

## Installing (unpacked)

1. Download or clone this folder.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Pin the TabUnloader icon for quick access; click ⚙ in the popup to open settings.

Requires Chrome 102+ (for `chrome.storage.session`); the manifest declares `minimum_chrome_version: 105`.

No permissions prompts appear: the extension requests only `tabs`, `storage`, and `alarms`,
and no website access.

---

## Using TabUnloader

**Popup sections**

- **Header** — extension name and automatic-unloading status (on/paused/off, current timeout).
- **Startup protection** — status badge (including how many tabs are *waiting for
  activation*) and the "Load active tab automatically on startup" toggle.
- **Inactivity unloading** — master toggle, timeout dropdown (30 s … 1 h, Custom, Never),
  pause/resume button.
- **Dashboard** — total / loaded / unloaded / protected tabs, plus waiting-for-activation,
  excluded, and per-session auto/manual/failed discard counters. An optional (clearly
  labeled) rough memory estimate can be enabled in settings.
- **Current tab** — status: *Active and loaded*, *Unloaded*, *Waiting for activation*,
  *Protected*, *Excluded by rules*, or *Cannot be discarded* (browser-internal pages).
- **Actions** — unload this tab, unload all eligible inactive tabs (two-click confirm),
  protect/unprotect, keep this tab loaded, open settings.

**Note on "Unload this tab":** Chrome documents that `tabs.discard()` does not discard the
tab currently in focus — and the tab under the popup always is. The button therefore tries
once, and if Chrome refuses it turns into **"Switch away & unload this tab"** for 6 seconds:
clicking it again moves you to the neighbouring tab and then unloads the original one (with
your explicit consent, since changing your selected tab is a visible side effect). The
inactivity timer remains the fully automatic alternative: just switch away and wait.

---

## Settings reference

| Setting | Default | Notes |
| --- | --- | --- |
| Unload inactive tabs automatically | On | Master switch for inactivity unloading only |
| Unload after | 5 minutes | 30 s, 1/2/5/10/15/30 min, 1 h, Custom (10 s–7 days), Never |
| Startup protection | On | Keeps restored tabs unloaded until activated |
| Load active tab automatically on startup | Off | ON lets the initially selected tab load normally |
| Group load guard | On | When a tab group is opened, immediately unload its background tabs again |
| Protect pinned tabs | On | Pinned tabs skipped by all automatic unloading |
| Protect audio-playing tabs | On | Tabs currently playing sound are skipped |
| "Keep This Tab Loaded" mode | Session | *Permanent* adds the tab's site to the exclusion list |
| Website exclusions | none | `mail.google.com`, `*.example.com`, `localhost` — scheme/port allowed, paths rejected |
| Theme | System | Light / dark / system |
| Memory estimate | Off | Optional, user-defined MB-per-tab multiplication — explicitly not a measurement |

All settings are stored in `chrome.storage.local`, applied immediately (no restart), and
restored after Chrome restarts. **Reset settings** restores defaults.

---

## Known Chrome API limitations

These are platform facts, verified against the current
[Tabs API documentation](https://developer.chrome.com/docs/extensions/reference/api/tabs),
[service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
and [Alarms API](https://developer.chrome.com/docs/extensions/reference/api/alarms) docs:

1. **Initial restored loads cannot be fully prevented.** Chrome starts loading
   session-restored pages before an extension service worker can run. No supported API lets
   an extension pause or cancel those first requests (`tabs` and `webNavigation` are
   observational; `declarativeNetRequest` can block requests but cannot *delay and later
   resume* them, and doing so for arbitrary restored tabs would break pages). TabUnloader
   therefore discards restored tabs *as early as the API permits* — this reliably frees the
   memory, but **does not guarantee zero initial network requests**. The extension never
   claims otherwise.
2. **The focused tab cannot be discarded.** `chrome.tabs.discard(tabId)` is documented to do
   nothing for the active tab. With "Load active tab automatically on startup" OFF, the
   initially selected tab is therefore loaded by Chrome and only discarded after you switch
   away from it.
3. **A tab that is active in its own window** (including background windows) cannot be
   discarded while that window exists.
4. **Timing granularity.** Scheduling uses `chrome.alarms`, which is limited to one fire per
   30 seconds in packaged extensions, so unloading can lag the configured timeout by up to
   ~30 seconds.
5. **Unsaved work cannot be detected.** Chrome exposes no general signal for unsaved forms,
   active video calls, or background work. Only detectable signals are used (`pinned`,
   `audible`) plus your own rules; use Protect/Exclusions for anything else.
6. **`audible` is approximate** — it reflects the last couple of seconds of audio output.
7. **Discarding is not closing.** Discarded tabs remain in the tab strip, keep their URL,
   order, group and pinned state, and reload on activation — but their JavaScript state is
   gone.
8. **Memory numbers are not measurable.** Chrome provides no reliable per-tab memory API to
   extensions. The dashboard shows tab counts; the optional estimate is arithmetic on a
   user-chosen figure, never a measurement. Use Chrome's own Task Manager
   (Menu → More tools → Task Manager) for real numbers.
9. **Chrome's own discarding** (Memory Saver / low-memory discard) can discard tabs
   independently. TabUnloader treats `tab.discarded` as ground truth on every sweep, so its
   state tracking stays correct even when Chrome discarded a tab itself.
10. **Opening a tab group makes Chrome load all of its tabs** — there is no Chrome setting
    or supported API to stop those loads from starting. The **group load guard** (on by
    default) re-unloads the group's *inactive* background members immediately after Chrome
    loads them, so only the tab you are actually viewing stays in memory. Tabs you opened
    deliberately (middle-click / `target=_blank`, which carry an opener tab) are left
    alone, as are tabs you used earlier in the session. Like the startup gate, this
    feature is user-controlled and independent of the inactivity timer (it also applies
    while automatic unloading is paused or set to Never); turn it off in Settings if you
    prefer group tabs to stay loaded once Chrome has loaded them.

---

## Testing guide

Automated checks (optional, needs Node.js 18+):

```bash
npm run check      # ESM syntax check on every JS file + manifest/PNG validation
npm run selftest   # 52 unit tests for settings, pattern matching, classification
npm run simulate   # drives the REAL service worker against a mock chrome.* API:
                   # startup with 20 restored tabs, activation, inactivity timing,
                   # timeout changes, fresh install, bulk unload, tab removal,
                   # restore-storm recovery, switch-away unload, group load guard
```

Manual acceptance tests in Chrome (load the extension unpacked first):

### Test 1 — Startup (most important)

1. Enable startup restoration: `chrome://settings/onStartup` → *Continue where you left off*.
2. Open ≥ 10 different websites. Watch Chrome's Task Manager
   (`Shift+Esc`): note memory usage.
3. Quit Chrome completely, keep Wi-Fi connected, relaunch.
4. **Observe with the extension's popup open:** expect restored tabs to show *Waiting for
   activation* / *Unloaded* counts, with tabs disappearing from memory per the Task Manager.
5. Verify: all tabs still visible; original URLs intact; the extension deliberately loads
   nothing; the initially selected tab behaves per the "Load active tab automatically on
   startup" setting.
6. Open `chrome://net-internals/#events` (or DevTools → Network on the one tab you open) to
   confirm the extension itself issues no page requests — while accepting that Chrome may
   have started some restored loads before the extension could act (see limitation #1).
7. Repeat with Wi-Fi disconnected: behavior must be identical.

### Test 2 — Individual activation

1. With ≥ 10 unloaded tabs, click one. It loads its original site.
2. All other tabs remain unloaded (check the popup dashboard before/after).
3. No duplicate tabs are created; tab order is unchanged.

### Test 3 — Inactivity timer

1. Set the timeout to 5 minutes (default).
2. Open Tab A, use it, switch to Tab B at 10:02.
3. By ~10:08 (worst case, +30 s scheduler granularity) Tab A shows *Unloaded* in the popup
   and its memory is released in Task Manager — but the tab is still visible.
4. Click Tab A → the page reloads.

### Test 4 — Manual unloading

1. Open several tabs; note which is active.
2. Popup → *Unload all eligible inactive tabs* → confirm.
3. Active tab stays loaded; eligible inactive tabs become unloaded; the popup reports exact
   success/failure counts (also visible as session statistics).

### Test 5 — Exclusions and protection

1. Pin a tab (pinned protection on) → it is never unloaded automatically.
2. Play audio in a tab → it is protected while audible.
3. Protect a tab via the popup → excluded from automatic unloading; unprotect restores rules.
4. Add `*.example.com` in settings → all example.com tabs are skipped; invalid patterns
   (paths, spaces) are rejected with an explanation.
5. Open `chrome://extensions` → shows *Cannot be discarded*.

### Test 6 — Restart recovery

1. Configure a custom timeout, exclusions, and theme; protect a tab; restart Chrome.
2. Settings, exclusions and theme persist. Per-tab protection and pause are session-scoped by
   design (tab IDs are not stable across restarts).

### Test 7 — Service worker & edge cases

1. `chrome://extensions` → *Service worker* link: open it, confirm no errors in the console.
2. Reload the extension mid-session (update simulation): alarms are re-armed, settings kept.
3. Rapidly switch between tabs: no crash, no unexpected discards, no reload loops.
4. Disable automatic unloading, restart Chrome: startup protection still keeps restored tabs
   unloaded (independence check).
5. Multiple windows: switch between windows; inactivity tracking follows focus; the active
   tab of each window is never discarded.
6. Close a tab manually: popup counts update; no errors when the sweep next runs.

### Test 8 — Tab groups (group load guard)

1. Put ≥ 4 tabs into a group; use one of them, leave the others unopened; keep a fifth
   tab ungrouped and a sixth opened deliberately via middle-click inside the group.
2. Click the group name in the tab strip to open it. Chrome starts loading every member.
3. Within moments, the popup's *Still loaded* list must show only: the tab you are
   viewing, the group tab you used earlier, and the middle-clicked one — the untouched
   group members return to *Unloaded* (verify in `chrome://discards` or Task Manager).
4. Ungrouped background loads are unaffected (they follow the normal inactivity timer).
5. Settings → turn the group load guard off, reopen the group: now every member stays
   loaded, exactly like plain Chrome.

### Squeezing out maximum savings

The popup's **Still loaded** panel explains, per tab, exactly why it is still holding
memory (active, pinned, audio, protected, excluded, or simply inside the inactivity
window). To get the lowest possible total:

1. Set the timeout to **30 seconds** (Settings → Inactivity timeout).
2. Review **pinned-tab protection** — if you don't need pinned tabs kept warm, turn it
   off in Settings.
3. Audit the **exclusion list** — every excluded site stays loaded by design.
4. Use **Unload all eligible inactive tabs** right after each Chrome start.
5. **Minimize windows, don't just switch away:** the tab that is active in *its own*
   window can never be discarded by Chrome while that window exists — so N windows keep
   at least N tabs loaded. Merging windows (drag tabs together) releases those too.
6. Know the floor: Chrome's browser, GPU, network and extension processes several hundred
   MB regardless of tab count. On Windows, Task Manager will always show that baseline;
   discarded tabs release their renderer, which is the part TabUnloader reclaims.

### Resource usage

Compare Chrome's Task Manager before/after unloading several heavy tabs. Report *measured*
values only — recovery depends on the pages, Chrome version, and OS. The extension's own
footprint is one idle `tabs.query` per 30 s plus event handlers.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Popup shows "Could not read extension state" | Service worker errored — open `chrome://extensions` → *Service worker* and check the console; reload the extension. |
| Tabs are not unloading | Check: automatic unloading on, timeout not "Never", not paused, tab not pinned/audio/protected/excluded, tab not active in its window. Popup badge shows the current reason via per-tab status. |
| Unloading lags the timeout by ~30 s | Expected — `chrome.alarms` minimum period is 30 s (limitation #4). |
| Restored tabs still briefly load at startup | Expected platform limitation (#1). Memory is still reclaimed within seconds. |
| "Unload this tab" reports Chrome refused | Expected for the focused tab (#2). The button then offers "Switch away & unload this tab" — click it again to confirm, or let the inactivity timer handle it. |
| An unloaded tab's hover card still shows "Memory usage" | The hover card is Chrome's own sampled display and can show a stale last value. Verify real state with `chrome://discards` (authoritative per-tab lifecycle list) or Chrome's Task Manager totals (Shift+Esc), not the hover number. Note: *frozen* tabs (Energy Saver) still hold memory — only *discarded* tabs release it. |
| A restored tab is still using memory after startup | The popup badge shows "N restored still loaded" while any guarded tab remains loaded. TabUnloader retries automatically on each new page load. You can also click *Unload all eligible inactive tabs*, or just switch away and let the inactivity timer handle it. Reload the extension at `chrome://extensions` after updating its files. |
| Opening a tab group loads all of its tabs | Chrome does this natively and provides no way to prevent it. With the **group load guard** on (Settings, default), TabUnloader immediately unloads the group's background tabs again — only the tab you view stays loaded. Tabs you deliberately opened yourself (middle-click) and tabs you used earlier in the session stay loaded. Disable the guard in Settings if you prefer the old behavior. |
| Group tabs briefly flash a loading spinner | Unavoidable: Chrome starts the load itself; the guard can only unload the tab right after. The memory is released again within moments. |
| Extension stops working after Chrome update | Re-open `chrome://extensions`, reload the unpacked extension; alarms and state re-initialize automatically. |
| Settings changes seem ignored | They apply on the next sweep (≤ 30 s). The popup refreshes immediately from live state. |
| A site lost my form input after unloading | Expected consequence of discarding; add the site to exclusions or protect the tab. |

---

## Packaging for the Chrome Web Store

1. Bump `"version"` in `manifest.json`.
2. Run `npm run check && npm run selftest && npm run simulate`.
3. Create a zip of the folder contents (not the folder itself), excluding dev files:

   ```bash
   # macOS / Linux
   zip -r tabunloader.zip . -x "node_modules/*" "tools/*" "package*.json" ".git/*"
   ```

   ```powershell
   # Windows (PowerShell)
   Compress-Archive -Path manifest.json, service-worker.js, common.js, common.css, `
     popup.html, popup.css, popup.js, options.html, options.css, options.js, icons `
     -DestinationPath tabunloader.zip -Force
   ```

4. Upload at <https://chrome.google.com/webstore/devconsole>. The store listing must disclose
   the `tabs`, `storage`, and `alarms` permissions (all justified in the Privacy section of
   the options page).

---

## Project structure & development

```
tabUnloader/
├── manifest.json          # MV3 config (permissions: tabs, storage, alarms)
├── service-worker.js      # background logic (module service worker)
├── common.js              # shared settings + classification logic (also unit-tested)
├── popup.html / .css / .js
├── options.html / .css / .js
├── common.css             # theme variables (light/dark) + shared components
├── icons/icon{16,32,48,128}.png
├── tools/
│   ├── check.mjs          # syntax + manifest validation (npm run check)
│   ├── selftest.mjs       # logic unit tests (npm run selftest)
│   ├── simulate.mjs       # mock-Chrome scenario tests of the real worker
│   └── generate-icons.mjs # dependency-free icon renderer (npm run icons)
└── README.md
```

`package.json` exists only for the dev scripts; Chrome ignores it. The extension has zero
runtime dependencies.

---

## Privacy

- Runs 100% locally. No account, no servers, no network requests of its own.
- No browsing history, URLs, titles, or page contents are collected, stored persistently, or
  transmitted anywhere.
- No analytics, tracking, or advertisements. No third-party dependencies.
- Permissions: `tabs` (read tab state and discard pages), `storage` (settings +
  per-session state), `alarms` (scheduled sweeps). No host permissions, no content scripts.
- Runtime state in `chrome.storage.session` is cleared automatically when Chrome exits.
