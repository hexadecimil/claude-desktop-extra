# SPEC: Extra settings panel in 3P mode

## Objective
The claude-desktop-extra "Extra" settings group never appears in the Settings dialog when Claude Desktop runs in 3P (third-party inference) mode. In 1P it works (`[ExtraSettings] ... Extra nav group added` in `~/.config/Claude/logs/claude-patches.log`); in 3P there is no `[ExtraSettings]` log line at all.

Users: anyone running claude-desktop-extra with a gateway / Bedrock / Vertex / Foundry 3P config.

## Root cause
In 3P the main window loads the bundled SPA from `app://localhost` instead of `https://claude.ai`. Two main-process gates in `js/extra_settings_main.js` only accept http(s) claude origins:

- **Gate A, injection** (`dom-ready` hook, ~L1739-1745): `if (!/^https?:\/\//i.test(url)) return;` drops `app://localhost` before `insertCSS` / `executeJavaScript`.
- **Gate B, IPC sender check** (`__cdbEx_ALLOWED_ORIGINS` ~L1196-1201, `__cdbEx_okSender` ~L1213-1220): only claude.ai / claude.com (+ previews), so every `cdbExtra.*` call from `app://localhost` is rejected.
- Same origin list in `js/window_transparency.js` (~L315-320, ~L435-441) guards the `cdb-wt:*` channels used by the panel's Transparency section.

Trap: `new URL("app://localhost/x").origin === "null"` in Node/Chromium, so adding `"app://localhost"` to the list alone never matches. Upstream's own eIPC validator normalises with `origin === "null" ? protocol + "//" + host : origin`.

Known limitation recorded in CHANGELOG.md L469-472; this spec removes it.

## Change
1. `js/extra_settings_main.js`
   - Add origin normaliser: `o = u.origin; if (!o || o === "null") o = u.protocol + "//" + u.host;`
   - Allow exact origin `app://localhost` in addition to the existing https origins.
   - `dom-ready`: replace the scheme regex with the shared origin check (also narrows 1P injection from "any https page" to the allowed origins). Skip `app://localhost/setup-desktop-3p` (upstream setup window, no settings dialog).
   - Keep the main-frame-only sender check.
2. `js/window_transparency.js`: same normaliser + allow-list for `cdb-wt:*`.
3. CHANGELOG.md: entry under Unreleased; drop the "never mounted in 3P" limitation note.

Out of scope: any change to upstream's 3P model validation; theme handlers (no sender guard, work once Gate A is fixed); DOM anchors in `js/extra_settings_page.js` (shared ion-dist frontend, expected to match).

## Acceptance criteria
- In 3P mode, Settings shows the Extra nav group and its sections render; `~/.config/Claude-3p/logs/claude-patches.log` contains `[ExtraSettings] ... Extra nav group added`.
- Panel actions (`cdbExtra.*`, Transparency `cdb-wt:*`) succeed from `app://localhost` main frame.
- 1P unchanged: panel still renders on claude.ai.
- Rejected: subframes, `app://other`, `app://localhost.evil`, `app://localhost:1234`, `file://...`, `http://localhost:3000`, `https://evil.example`.

## Commands
- Tests: `node scripts/tests/core/test-deployment-main.mjs` and the new/updated core tests (run the repo's core test runner as documented in AGENTS.md).
- Build/install per AGENTS.md; verify by launching `claude-desktop --3p` and opening Settings.

## Testing strategy
- `scripts/tests/core/test-deployment-main.mjs` section [11]: add `app://localhost/`, `app://localhost/new?x=1` to allowed; add the foreign URLs above to rejected; assert subframe `app://localhost` is rejected.
- New dom-ready case using the fake `appEvents["web-contents-created"]` + `wc.fire("dom-ready")` pattern (see `test-theme-scope.mjs`, `test-spinner-main.mjs`): injection happens for `https://claude.ai/new` and `app://localhost/new`, not for the foreign URLs or `app://localhost/setup-desktop-3p`. Fails before the fix.
- Equivalent allow/deny cases for `window_transparency.js` sender guard.
- Manual: 3P launch on the installed build, check log line + visual.

## Code style
Match surrounding code: plain ES5-style JS in the injected files, existing `__cdbEx_` naming, existing log prefix `[ExtraSettings]`. No new dependencies.

## Boundaries
- Always: keep main-frame-only check; exact-origin matching (no prefix/suffix matching).
- Ask first: widening allowed origins beyond `app://localhost`; touching patch .nim files.
- Never: alter upstream's model/inference validation; commit unless asked.
