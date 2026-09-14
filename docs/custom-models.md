# Custom models in the Code picker

Lists models served by an **Anthropic-compatible endpoint** - DeepSeek's `/anthropic` API is the reference, a gateway works the same way - in the Code tab's model picker, **next to** Anthropic's own models, and routes the sessions that pick one to that endpoint with your own key. Everything else keeps going to Anthropic on your subscription: this is additive. It is not the [third-party inference](third-party-inference.md) mode, which is exclusive - a 3P deployment replaces the subscription login, hides the Chat tab and moves your data to a separate profile. Here you keep all of that and gain a few more entries in one menu.

Community feature: **Settings → Extra → Community Features → Custom models** is the switch, **Settings → Extra → Models** the editor. Off leaves the picker and the sessions exactly as Anthropic ships them.

## Setup from the app

**Settings → Extra → Models → Add a provider.** Pick a preset (DeepSeek, Kimi, GLM, MiniMax, Qwen, OpenRouter, or a gateway) or fill in a provider id and the endpoint's base URL by hand, paste the API key, **Add provider**. A preset knows the endpoint, where the provider lists its models, which effort levels its API accepts and, when every model it serves has it, the context window - not the models themselves, which age too fast: **Fetch models** on the card asks the provider for its list and you tick the ones to add - a filter box narrows a long list, and a listing that states each model's context length (OpenRouter's) sets the added model's [context window](#context-window) by itself (it also works for an unknown provider whose `/v1/models` follows the OpenAI shape). **test** sends one token with the stored key, so a wrong URL or key shows there rather than as a failed session; **detect** (in the provider form) asks which effort levels it accepts. **Add a model** / **edit** set the model id, the display name, images, thinking, the web search tool, the default effort, the [context window](#context-window), an optional badge, and the model's [sub-agent type](#sub-agents) - the name Claude launches it under, on by default. **Reload the Code tab** (the button next to the switch, or a restart): the picker lists the new entries after the Claude models. The routing itself is live - see [What reaches open sessions](#what-reaches-open-sessions).

The panel writes the providers and models to `claude-desktop-extra.json` in the profile dir and the key to `custom-models/secrets.json` next to it (0600 in a 0700 directory). The key is write-only: it is never shown again and never reaches the page.

## Setup from the config file

The same configuration can be written by hand in `~/.config/Claude/claude-desktop-extra.jsonc` (`~/.config/Claude-<profile>/` for a named [profile](profiles.md)); a provider set there is shown locked in the panel.

1. Put your key in a file of its own (recommended - the .jsonc is otherwise readable by anything that reads your config):

   ```bash
   install -m 600 /dev/null ~/.config/deepseek.key && $EDITOR ~/.config/deepseek.key
   ```

2. Add a `customModels` block:

   ```jsonc
   {
     "customModels": {
       "providers": [
         {
           "id": "deepseek",
           "baseUrl": "https://api.deepseek.com/anthropic",
           "apiKeyFile": "~/.config/deepseek.key",
           "models": [
             {
               "id": "deepseek-flash",
               "name": "DeepSeek Flash",
               "description": "DeepSeek V4.1 Flash - 1M context, vision, thinking"
             }
           ]
         }
       ]
     }
   }
   ```

3. Restart Claude Desktop (or reload the Code tab). The picker in the Code tab lists **DeepSeek Flash** after the Claude models, with the same effort menu. Pick it and the session's requests go to `api.deepseek.com`; pick Opus again and they go back to Anthropic. Claude can launch it as a sub-agent too - `Agent(subagent_type: "deepseek-flash")`, or `agent(prompt, {agentType: "deepseek-flash"})` in a workflow - and a workflow can name the model directly: `model: "claude-deepseek-flash"` (see [Model ids](#model-ids)) - `claude-deepseek-flash[1m]` for the CLI to treat it as the 1M model it is (see [Context window](#context-window); with `"preset": "deepseek"` on the provider the picker lists it that way by itself). A line in every new session's system prompt tells Claude all of this (see [Sub-agents](#sub-agents)).

`logs/claude-patches.log` in the profile dir shows what was listed (`[custom-models] bootstrap enriched: …`) and `logs/custom-models.log` what was routed, one line per request, never the key.

## Reference

```jsonc
"customModels": {
  "enabled": true,               // the switch. Absent = on as soon as a model is configured.
                                 // Set HERE it locks the Settings switch; the switch itself writes
                                 // claude-desktop-extra.json.
  "webSearch": "deepseek-flash", // app-wide: every web search in a Code session is a separate
                                 // one-tool request the CLI sends to a small Claude model, whatever
                                 // the session's model. Name a custom model (id or claude-<id>) or
                                 // any Anthropic id (claude-opus-5) to send those there instead.
  "subagentModel": "deepseek-flash", // optional: the model of every sub-agent that names none - the CLI's
                                 // own Explore, Plan and general-purpose included (CLAUDE_CODE_SUBAGENT_MODEL).
                                 // Default: the CLI's, the session's model. See Sub-agents
  "announce": true,              // one line in every new session's system prompt telling Claude the ids
                                 // and sub-agent types exist. Default: on
  "surfaces": ["ccd", "code"],   // which pickers list them, as the bootstrap names them. The desktop
                                 // Code tab reads two: "ccd" (the menu's catalogue) and "code" (the
                                 // session's effort options and available ids). Then "ccr" Claude
                                 // Code on the web, "chat", "cowork", "design"... Default: those two -
                                 // a Cowork session runs in a VM and cannot reach the preload.
  "providers": [
    {
      "id": "deepseek",                                  // label for logs and the Settings state line
      "baseUrl": "https://api.deepseek.com/anthropic",   // the endpoint; /v1/messages is appended
      "apiKey": "sk-...",                                // or apiKeyEnv: "DEEPSEEK_API_KEY" (from the
      "apiKeyFile": "~/.config/deepseek.key",            // app's environment), or apiKeyFile (trimmed),
                                                         // or apiKeyStored: true (the panel's secrets file)
      "preset": "deepseek",                              // set by the panel: which preset's endpoint knowledge applies
      "modelsUrl": "https://api.deepseek.com/v1/models", // where "Fetch models" asks (optional, found automatically)
      "effort": ["low", "high", "max"],                  // the effort values this provider's API accepts under the
                                                         // app's names - every model inherits them (default: all five)
      "context": "1m",                                   // "200k" | "1m" | "both": how its models are listed, see
                                                         // Context window. Default: the preset's knowledge, else 200k
      "headers": { "x-extra": "1" },                     // optional, added to every request
      "effortMap": { "xhigh": "high" },                  // optional, see Effort below
      "models": [
        {
          "id": "deepseek-flash",     // the provider's model id. Exposed to the app as claude-deepseek-flash
          "name": "DeepSeek Flash",   // picker label (default: the id)
          "description": "...",       // picker subtitle
          "badge": "beta",            // optional neutral badge next to the name
          "context": "1m",            // "200k" (listed as claude-<id>), "1m" (as claude-<id>[1m], the
                                      // only spelling the CLI reads as a 1M window) or "both" (the two,
                                      // "<name>" and "<name> 1M", the way Sonnet/Opus 1M are offered).
                                      // Default: the provider's. "context1m": true still means "both"
          "vision": true,             // false: images are replaced by a placeholder line
          "thinking": true,           // false: no effort menu, no Thinking switch, thinking always off
          "webSearch": true,          // false: the provider's API does not run Anthropic's server-side
                                      // web_search tool for it - the tool is stripped from its requests
                                      // and it is not offered as the app-wide web-search model. The
                                      // CLI's own WebSearch tool stays: the model can still search, the
                                      // search itself runs where `webSearch` above says
          "effort": ["low", "max"],   // file-only override of the provider's levels for this model
          "effortDefault": "max",     // the one marked as default in the picker's menu (default: xhigh when
                                      // offered, else the highest). Applied when the model is picked and the
                                      // session's current level is not one it offers; a level it does offer
                                      // is kept across the switch, as the app does for its own models
          "agent": {                  // its sub-agent type (see Sub-agents). Absent: on, everything
            "name": "deepseek-flash", // generated. false: no type. name: lowercase letters, digits and -
            "description": "...",     // (default: the display name slugged); description: what Claude
            "prompt": "..."           // reads to decide when to launch it; prompt: its system prompt
          }
        }
      ]
    }
  ]
}
```

The `.jsonc` (hand-edited) and the `.json` (written by the Settings panel) are merged: `enabled` and `surfaces` come from the `.jsonc` when set there (the switch then shows itself as locked), else from the `.json`; providers come from **both** lists, a `.jsonc` provider being locked in the panel and winning over a `.json` one with the same id. So the panel and the file can be used side by side, and the switch never touches your providers.

### Model ids

The Claude Code CLI only accepts model ids matching `^claude-\S+$` when the app switches a session's model, so every custom id is exposed as **`claude-<id>`** (`deepseek-flash` → `claude-deepseek-flash`; a 1M context adds the `[1m]` suffix, `claude-deepseek-flash[1m]`). That is the id the picker sends, the id sub-agents and workflows use, and the id the routing recognises - with or without the suffix, both spellings reach the same provider model; the provider receives the bare `deepseek-flash`. An id that already starts with `claude-` (a gateway serving Claude models) is used as is - and then routed to that gateway, which is presumably why it was listed.

### Context window

The CLI decides a model's context window from its id alone: a model it does not know gets **200k**, and the only thing that changes that is the **`[1m]`** suffix - the spelling it uses for Sonnet/Opus 1M - which means **1M** (`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is ignored for `claude-` ids). The window is not a display detail: it sets the context gauge and the point where the session auto-compacts, so a natively-1M model listed under its bare id is compacted around 200k. Hence the per-model `context`: `"200k"` lists `claude-<id>`, `"1m"` lists `claude-<id>[1m]` only, under the model's plain name, and `"both"` lists the two as `"<name>"` and `"<name> 1M"`, for a provider that prices the two windows differently, the way Anthropic does for Sonnet. The DeepSeek preset sets `"1m"` for its provider (every DeepSeek model serves 1M at one price), the others leave 200k; the model form shows the inherited value and lets each model differ.

### What reaches the provider

The target is Anthropic-**compatible**, not Anthropic, so the CLI's request is reduced to the documented subset of the Messages API: `model`, `max_tokens`, `stream`, `temperature`, `top_p`, `stop_sequences`, `system` (text blocks), `messages` (text, image, tool_use, tool_result, thinking, native web search), `tools` (name/description/input_schema, plus the server-side web search tool), `tool_choice`, `thinking`, `output_config.effort`. Dropped: `metadata`, `context_management`, `top_k`, every `cache_control`, MCP toolsets, `document` blocks other than plain text (replaced by a one-line placeholder), the `anthropic-beta` headers and the Anthropic OAuth `Authorization` (the provider gets `x-api-key` only). Mid-conversation `system` messages (the CLI's `/effort` and friends) are folded into the next user turn as `[system] …`, and turns are merged to keep the strict user/assistant alternation. `count_tokens` is estimated locally (chars / 4) - the compatible endpoints do not serve it.

**Effort.** The picker's effort menu lists the levels the provider accepts (`providers[].effort`, default all five: low, medium, high, xhigh, max - an API convention of the provider, inherited by its models) and sends the chosen one unchanged as `output_config.effort`. DeepSeek knows `low`, `high`, `max`, so its preset sets exactly those and the default lands on `max` (the setting its benchmarks ran at). **detect** in the provider form asks the provider itself - one token with each level to its first model - and ticks what it accepted; that settles strict APIs (a refused name is a 400) but not permissive ones: DeepSeek answers 200 to all five names and folds the extra ones (`xhigh` → `high` per its docs), which is exactly why its preset lists three. No provider exposes its list of levels - the preset is the documentation, detect the experiment, and the run-time fallback the safety net. Should a provider still refuse a level, the request is retried once without effort and the refusal is logged. `effortMap` (per provider) renames levels on the way out for the rare API that spells them differently; without it, `medium` and `xhigh` are sent as `high` and `max` when they reach a provider that was not given an explicit list. Effort never travels with thinking off (DeepSeek answers 400 to that), and the thinking budget is clamped to 16 000 tokens.

**Switching models mid-session.** A history that carries thinking blocks signed by Claude may be refused by the provider with a 400 mentioning the signature; the request is retried once without those blocks. A provider 401/403 (wrong or revoked key) is turned into a plain 400 (`invalid_request_error`) carrying the provider's message, because a 401 would make the CLI refresh its own OAuth token and retry without end, and an `authentication_error` type would make the app re-authorise its own login and restart the session's CLI; other errors are returned to the CLI as they are.

### What reaches open sessions

Two different things change at two different times:

- **Routing** (a key pasted or fixed, a model added or removed, a provider removed, the web-search target, the switch) is live: the app rewrites `custom-models/routes.json` at every change - the panel's writes, and hand edits of the `.jsonc`/`.json` or of `secrets.json`, which are watched - and every open session re-reads it on its next request. A wrong key corrected in the panel works on the very next message; `/model claude-<new id>` and a workflow naming a new model work without a restart.
- **The picker** is drawn from the page's bootstrap, so a new entry shows in the menu after the Code tab reloads - the **Reload the Code tab** button next to the switch does it (open sessions keep running).

The one exception: a session opened before your very first provider existed was spawned without the preload (the feature contributes nothing to a session while nothing is configured), so it needs the app restarted once.

### Sub-agents

Every model is also a **sub-agent type**, handed to the CLI when a session opens - the same
programmatic definitions the Agent SDK's `agents` option carries, so nothing is written under
`~/.claude/agents/`. Claude launches it by name: `Agent(subagent_type: "deepseek-flash", ...)`, or in a
workflow script `agent(prompt, {agentType: "deepseek-flash"})`. The name is generated from the display name
(`DeepSeek Flash` → `deepseek-flash`, `gemini-3.8-flash` → `gemini-3-8-flash`), never one of the CLI's
built-in types, never twice (the provider id, then a counter, break a tie); the model form lets you set the
name, the **description** - what the orchestrating Claude reads to decide when to use it, so a role and its
limits in your words beat the generic line - and the system prompt. A model listed with a 1M twin runs its
agent on the twin. Untick **Sub-agent type** for a model that should stay picker-only. A file of the same
name in `~/.claude/agents/` defines a second type of that name; rename one.

The Agent tool's own `model` parameter is an enum of Anthropic tiers (`sonnet`, `opus`, `haiku`, ...)
validated inside the CLI: it cannot name a custom model, and the panel does not pretend otherwise. Two
other levers exist, both the CLI's own and both read when a session opens:

- **Default sub-agent model** (`subagentModel`, `CLAUDE_CODE_SUBAGENT_MODEL`): the model of every
  sub-agent whose definition names none - the built-in `general-purpose` and `Plan` types, a workflow's
  `agent()` without a model, an agent file without `model:`. Not `Explore`, which the CLI pins to the
  session's model (`inherit`), and not a sub-agent with a model of its own. (The CLI's
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` overrides those too, the types above included - set it by hand in
  the app's environment if that is what you want; the panel does not offer it.)
- **Tell Claude about custom models** (`announce`): one line appended to the system prompt of every new
  session, listing the ids, the types and how to launch them, and saying where the ids are refused.
  Without it Claude knows only what your CLAUDE.md says. The panel shows the exact line.

Because all three travel in the session's `initialize` request, a session already open keeps what it got;
the routing itself stays live.

### Where the key goes

To the CLI only: in the environment of the Code-tab session at spawn (the channel the app itself uses for provider credentials in 3P mode) - the preload deletes it from `process.env` before the CLI's own code runs, so nothing the session spawns (the Bash tool's shells, MCP servers, `bun`) inherits it - and in `custom-models/routes.json`, 0600 in a 0700 directory, which the preload re-reads for live changes (the same exposure as `secrets.json` next to it). It never reaches the page: the picker entries carry names and ids only. The log never prints it.

## How it works

Nothing local feeds the Code tab's model menu: the page (remote claude.ai code) builds it from `model_selector_config` in the `/api/bootstrap` response and then tells the app which ids exist. `modelPicker` in `~/.claude/settings.json` only reaches the CLI's own `/model`. So the patch (`patches/community/add_feature_custom_models.nim`) does three things:

- **Picker.** `js/custom_models_main.js` attaches the Chrome DevTools Protocol `Fetch` domain to claude.ai webContents, pauses the bootstrap *response*, and appends the configured entries to the surfaces it is configured for. The entries copy the shape the live bootstrap carries for that surface (name, short name, section, capabilities, the effort menu - whose localised labels are borrowed from the surface's own Anthropic entries), so the page renders them like any other model. Anthropic's list stays whatever the server sent, so new Claude models keep appearing. In subscription mode the app's own model validator accepts any id (the blocklist that rejects non-Anthropic names only runs in 3P mode), and the page reports the enriched list back to the app, which is what lets a session start on one of ours.
- **Routing.** The Claude Code binary is a compiled Bun program and honours `BUN_OPTIONS`. `cliEnv()` is spliced into the environment the app assembles for every Code-tab session (sub-patch B, anchored on the `DISABLE_MICROCOMPACT`/`NODE_USE_SYSTEM_CA` literals of that object) and adds `--preload=<userData>/custom-models/preload.js` - `js/custom_models_preload.js`, written there by the app - plus the resolved providers in `CDB_CUSTOM_MODELS_JSON` and the path of `routes.json` in `CDB_CUSTOM_MODELS_ROUTES`. The preload replaces `fetch` inside the CLI, forwards only requests whose model is one of ours, and re-reads `routes.json` (one `stat` per API request) when the app rewrites it; when the feature is off it contributes nothing and the session is exactly upstream's. A `BUN_OPTIONS` the app inherited from its environment is kept, our `--preload` appended once: any other preload named there runs in the CLI too, and a leftover `fetch` hook from an earlier setup can quietly serve what this one leaves alone (a custom id whose provider was just removed, for instance) - `CDB_CUSTOM_MODELS_DEBUG=1` shows the `passthrough` and a fresh `-p` run of the CLI with only our preload shows the error the CLI gives on its own.

- **Sub-agents.** The app opens every Code session with an `initialize` request to the CLI that carries, among other fields, `appendSystemPrompt` and `agents` - the Agent SDK's system-prompt suffix and programmatic sub-agent definitions. Sub-patch C routes both through `agents()` and `appendSystemPrompt()` of the main module (two literal anchors in the code-split chunk, each expected exactly once): one definition per model with a type, `{description, prompt, model: <listed id>}`, and the announce line. The CLI accepts any `--model`-valid id in a definition's `model` (checked 2026-09-14, CLI 2.1.266, with `--agents`), and honours `CLAUDE_CODE_SUBAGENT_MODEL` with such an id too. Off, both functions return the app's own values untouched.

Limits: local Code sessions only (an SSH remote or a Cowork VM does not have the preload). Whether a given provider's `/anthropic` endpoint supports a request shape (images, streaming, tools) is the provider's business; the log shows its answer. Anthropic's server-side `web_search` tool is served by DeepSeek's and OpenRouter's endpoints (verified 2026-09); a provider that refuses it answers 400 and the log shows it.

Debugging: `CDB_CUSTOM_MODELS_DEBUG=1` in the app's environment logs every API request the page makes (path only), the surfaces of each bootstrap, the `cliEnv()` calls and the answers to the page's model-selection writes, all under `[custom-models] debug:` in `logs/claude-patches.log`. The switch is passed to the sessions' CLI too: `logs/custom-models.log` then also gets one `passthrough <url> model=<id> (<reason>)` line per Messages request that was left alone (a Claude model, or a custom id whose route is gone), next to the `->` lines of the routed ones.

Tests: `scripts/tests/community/test-custom-models-main.mjs` (config merge, the panel's IPC and secrets file, picker entries, the CDP flow, the CLI env, the sub-agent definitions and the announce line), `test-custom-models-preload.mjs` (what leaves the CLI: URL, headers, body) the Models panel scenario of `scripts/tests/core/test-extra-settings-dom.mjs`, and `scripts/tests/core/test-extra-settings-bridge.mjs` (every field the panel sends reaches the main-side channel).
