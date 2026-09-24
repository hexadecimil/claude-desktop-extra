# Custom models - anchors

`patches/community/add_feature_custom_models.nim` and its two JS halves
(`js/custom_models_main.js` in the app, `js/custom_models_preload.js` inside the Claude Code CLI)
rest on three kinds of assumptions:

- **Build-time anchors** in the local bundle. Each is matched with an exact count; a move fails the
  build. Nothing to re-check by hand.
- **Local shapes the build does not assert.** Grep the new bundle after an upstream bump.
- **Remote and CLI behavior** that no build can see: the claude.ai bootstrap and model-selection APIs,
  and the internals of the Claude Code binary. These break at run time. The log lines at the end say
  which one moved.

Build-time anchors re-measured on **v2.7032.0** (2026-09-24). The claude.ai rows were observed live on
2026-09-13 by the feature's author; the CLI rows were checked against **CLI 2.1.266** (2026-09-14/15) and
re-read in **CLI 2.1.281** (2026-09-24).

## Build-time anchors (strict counts, the build fails if one moves)

| Sub-patch | Anchor (exactly one across the staged bundle) | Rewritten to |
|---|---|---|
| B | `async buildSessionEnv(<id>,<n>,…){let <id>={...<n>.sessionEnv}` - the Code session manager copying the session env at every spawn (the spread must be of its 2nd parameter) | `{...n.sessionEnv,...((globalThis.__cdbCustomModels&&…cliEnv(n.sessionEnv))\|\|{})}` |
| C | `appendSystemPrompt:this.initConfig?.appendSystemPrompt` and `agents:this.initConfig?.agents` in the Agent SDK's `Query.initialize` | each wrapped, with `this.transport` passed as the 2nd argument |
| C (assert) | `{this.transport=<id>,this.isSingleUserTurn=` - the Query keeps its transport | nothing (precondition) |
| C (assert) | `updateEnv(<id>){this.options.env?Object.assign(this.options.env,` - the transport keeps the spawn env in `options.env` | nothing (precondition) |
| D | `async configureSSHSpawn(<ids>){` - the Code session manager turning a session into an SSH/WSL one | `remoteSpawn(<first param>)` called first |

`rg` recipes: `rg -o 'buildSessionEnv\(.{0,80}' index*.js`, `rg -o 'subtype:"initialize".{0,600}' index*.js`,
`rg -o 'this\.transport=.{0,60}' index*.js`, `rg -o 'updateEnv\(.{0,80}' index*.js`,
`rg -o 'configureSSHSpawn\(.{0,40}' index*.js` (add `-a`/use `grep -a` if the file has NUL bytes).

## Local shapes (not asserted - grep them)

| Assumption | Where | Measured (v2.7032.0) | If it moves |
|---|---|---|---|
| B's site is not the base env builder: `getBaseQueryConfig` memoises `_fetchBaseQueryConfig` for 30 s (`BASE_CONFIG_TTL_MS=3e4`) | `getBaseQueryConfig(e){return this.baseConfigMemo.get(…)}` | as quoted - a splice there reached new sessions up to 30 s late | nothing to do while B stays in `buildSessionEnv`; moving it back means calling `invalidateBaseConfigCache()` on every config change |
| The SDK copies the session env into the transport options | `…,et=le?{...le}:{...process.env};et.CLAUDE_CODE_ENTRYPOINT\|\|="sdk-ts"` before `new <Transport>({…env:et,…})` | as quoted | `sessionRouted()` sees no marker: sub-agent types and the announce line silently stop (routing is unaffected) |
| The SSH/WSL remote spawner forwards only `CLAUDE_*`, `ANTHROPIC_*`, `DISABLE_*`, `ENABLE_TOOL_SEARCH` and host-authored keys | `function <id>(e){return e.startsWith("CLAUDE_")\|\|e.startsWith("ANTHROPIC_")\|\|e.startsWith("DISABLE_")\|\|e==="ENABLE_TOOL_SEARCH"…}` used by the remote env filter | as quoted: `CDB_*` (the keys) and `BUN_OPTIONS` never reach a remote host; `CLAUDE_CODE_SUBAGENT_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL` would, which is why `remoteSpawn()` takes them back | if the filter widens, `remoteSpawn()` still strips everything `cliEnv()` added - nothing to do |
| In subscription mode the app's model validator accepts any id (the blocklist of non-Anthropic names runs in 3P mode only) | the app-side validator behind `setAvailableCodeModels` | author, 2026-09-13 | a session refuses to start on a custom id |

## claude.ai (remote)

| Assumption | Used for | Observed | If it moves |
|---|---|---|---|
| The page fetches `/edge-api/bootstrap/<org>/app_start` (or the `/api/` spelling) and builds the Code picker from `model_selector_config` | `PATTERNS`, `enrichBootstrap()` | surfaces `ccd` (the menu) and `code` (effort options, available ids, persisted state); entry `{id, name, short_name, section, capabilities, thinking:{type:"effort"\|"effort_and_mode", effort_options, mode_options?}, quick_select?}`; labels localised server-side | no `bootstrap enriched` line after a Code-tab reload with the switch on; `CDB_CUSTOM_MODELS_DEBUG=1` logs every `page GET /…` path and the surfaces of each bootstrap |
| The page persists the pick with `PATCH /api/organizations/<org>/model_selector_state/<surface>`, refused with 400 for an id claude.ai does not know | `selectionOutcome()` answers it locally and remembers the pick in `custom-models/selection.json` | answer shape `{id, model, thinking, thinking_by_model:[{id, thinking}]}` | the picker forgets a custom model when the session ends; the log shows no `selection: … kept locally` line |

## Claude Code CLI (not in this bundle)

| Assumption | Used for | Checked (CLI 2.1.266) | If it moves |
|---|---|---|---|
| The compiled Bun binary honours `BUN_OPTIONS=--preload=<file>` and is named `claude` | loading the preload at all | yes | `logs/custom-models.log` gets no `active:` line when a session opens; routing never happens |
| Messages requests go through `globalThis.fetch(string\|URL, {body: string})` | `route()` | yes | with `CDB_CUSTOM_MODELS_DEBUG=1`: `passthrough … (Request object - not inspected)` |
| `/model` and `set_model` accept `^claude-\S+$`; a `[1m]` suffix means a 1M window | the `claude-<id>` aliases, the `context` modes | yes | the picker's choice is refused by the CLI; auto-compaction at 200k for a 1M model |
| Session turns carry `thinking: {type: "enabled", budget_tokens}` (or `"adaptive"`); light work (WebFetch synthesis, the classifier) carries none | `sanitize()` forwards thinking as asked | yes | thinking lost on turns, or forced on cheap calls |
| Server-side threads ("tether", GrowthBook `tengu_curious_tower`): a request may carry `thread: {type: "create"\|"continue", previous_message_id}` and, on a continue, only the messages after the anchor; a 400 with `error.details.error_code: "thread_unsupported_request"` makes the CLI resend the turn whole and keep that model stateless for the session | the preload refuses every routed request that carries `thread` with that code | 2.1.281 (`fne()`: `YAt(e)==="thread_unsupported_request"` → `unsupported_request` → `[tether] … resending this turn stateless`) | a custom model answers from a truncated conversation; `logs/custom-models.log` shows no `thread request … refused` line while the session loses context |
| The web-search sub-request is one request with exactly one `web_search_*` tool, on the small/fast model or on the session's model (GrowthBook `tengu_plum_vx3`) | `webSearch` routing (resolved before the requested model), the no-tool refusal | 2.1.281: `x("tengu_plum_vx3",!1)?Gy():p.mainLoopModel()` | web searches go to Anthropic's default again |
| `CLAUDE_CODE_SUBAGENT_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` are read verbatim, with no validation | the two app-wide slots | yes | sub-agents / WebFetch on the CLI's defaults |
| `initialize.agents` definitions take any `--model`-valid id; the Agent tool's own `model` is an enum of tiers | sub-agent types, the announce line's wording | yes | `Agent(subagent_type: <type>)` fails to launch |
| Anthropic refuses a `diagnostics.previous_message_id` it did not mint (not `msg_…`) | `foreignPreviousId()` sends null | yes | the first Anthropic turn after a custom-model turn fails with a 400 naming `previous_message_id` |

A local check of the CLI half, without the app: run `claude -p hi --model claude-<id>` with
`BUN_OPTIONS=--preload=<userData>/custom-models/preload.js`, `CDB_CUSTOM_MODELS_ROUTES=<userData>/custom-models/routes.json`,
`CDB_CUSTOM_MODELS_LOG=/tmp/cm.log` and `CDB_CUSTOM_MODELS_DEBUG=1`, then read `/tmp/cm.log`.

## Log lines → what moved

In `logs/claude-patches.log` (`[custom-models] …`) unless noted:

| Line | Meaning |
|---|---|
| `debugger attach failed` / `Fetch.enable failed` | the CDP route to the bootstrap is closed (Electron or Chromium change) |
| `bootstrap: not JSON (…) - passing the response through` | the bootstrap is no longer JSON the module can read |
| `bootstrap: <error> - passing the response through` | a CDP command on the paused response failed (`Fetch.getResponseBody` / `Fetch.fulfillRequest`) |
| no `bootstrap enriched: …` after a reload, switch on | the endpoint or the `model_selector_config` shape moved - see the claude.ai table |
| `the SDK query's transport has no options.env - upstream moved it` | the C preconditions hold in the bundle but not at run time; re-audit sub-patch C |
| `remote session: custom models left out …` | expected on every SSH/WSL session start (sub-patch D) |
| `logs/custom-models.log`: no `active:` line for a new session | the preload did not load - `BUN_OPTIONS` or the binary name |
| `logs/custom-models.log`: `refused: … is no longer configured` | expected: a session asked for a model that was removed or switched off |
| `logs/custom-models.log`: `thread request (…) … refused, the CLI resends it whole` | expected, once per model per session where the account has threads on |
| `logs/custom-models.log`: `refused: … redirected to …` | a provider redirected off its host; the key was not sent there |
