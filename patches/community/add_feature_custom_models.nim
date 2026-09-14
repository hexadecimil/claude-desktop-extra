# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Custom models: list models served by an Anthropic-compatible endpoint
# (DeepSeek's /anthropic API is the reference) in the Code tab's model picker
# NEXT TO Anthropic's own, and route the CLI's requests for them to that
# endpoint with the provider's key. Additive: the subscription login and every
# Claude model stay as they are - unlike 3p/managed-settings mode, which is
# exclusive. Driven by the `customModels` key of claude-desktop-extra.jsonc.
#
# Two sub-patches:
#   A. Prefix js/custom_models_main.js (with js/custom_models_preload.js
#      embedded) after "use strict";. It reads the config, attaches the CDP
#      Fetch domain to claude.ai webContents and appends our entries to the
#      `model_selector_config` of the /api/bootstrap RESPONSE (the page builds
#      the picker from it and reports the ids back to the app), and owns the
#      Settings switch IPC.
#   B. Splice `cliEnv()` into the base session environment of the Code tab's
#      session manager - `getBaseQueryConfig()` returns
#      `{sessionEnv:{...Xd({oauthToken,...}),DISABLE_MICROCOMPACT:"1",
#      NODE_USE_SYSTEM_CA:"1"},hostAuthoredEnvKeys:...}` and every Code session
#      (and the manager's temporary queries) starts from that object. Anchored
#      on the two stable literals DISABLE_MICROCOMPACT / NODE_USE_SYSTEM_CA that
#      close it. When the feature is off cliEnv() contributes {} and the
#      session is exactly upstream's; when on it adds BUN_OPTIONS=--preload=
#      <userData>/custom-models/preload.js (the Claude Code binary is a
#      compiled Bun program and honours BUN_OPTIONS) plus the resolved
#      providers in CDB_CUSTOM_MODELS_JSON. The two other env builders in the
#      bundle (`[LAM]`, the Cowork-local session, and a one-shot inference
#      helper) are deliberately not touched - verified 2026-09-13 by
#      instrumenting all three: only this one runs for a Code-tab session.
#   C. Route two fields of the session's `initialize` control request (the
#      one the app sends the CLI when a Code session opens: `{subtype:
#      "initialize",hooks,...,appendSystemPrompt:this.initConfig?.
#      appendSystemPrompt,...,agents:this.initConfig?.agents,...}`, in a
#      code-split chunk) through `agents()` / `appendSystemPrompt()` of the
#      main module. Those are the Agent SDK's programmatic sub-agent
#      definitions and system-prompt suffix: one sub-agent type per custom
#      model and one line that tells Claude the models exist. Each function
#      returns its input untouched when the feature is off.
#
# Break risk: VERY LOW for A (stable "use strict"; anchor). LOW for B - two
# literal anchors with an exact-count check; if upstream reshapes that object
# the build fails loud here. To find it again: rg 'sessionEnv:' across
# index*.js - the base-config builder is the one spreading an oauthToken env.
# LOW for C - two literal anchors, each expected exactly once across the
# concatenated bundle; to find them again: rg 'subtype:"initialize"'.

import std/[os, strutils]
import regex

const MAIN_JS = staticRead("../../js/custom_models_main.js")
const PRELOAD_JS = staticRead("../../js/custom_models_preload.js")

const MARKER = "__CDB_CUSTOM_MODELS__"
const PLACEHOLDER = "\"__CDB_CM_PRELOAD_SRC__\""
const ENV_SPLICE = ",...((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.cliEnv())||{})}"
# The Code tab's base session env: `DISABLE_MICROCOMPACT:"1",NODE_USE_SYSTEM_CA:"1"}`
# closes the sessionEnv object literal (quote-agnostic: the minifier flips
# between " and ` across releases).
let envSiteRe =
  re2"""(DISABLE_MICROCOMPACT:["`]1["`],NODE_USE_SYSTEM_CA:["`]1["`])\}"""
# Our injected end-state, asserted positively (Rule 6).
let envEndStateRe =
  re2"""NODE_USE_SYSTEM_CA:["`]1["`],\.\.\.\(\(globalThis\.__cdbCustomModels&&globalThis\.__cdbCustomModels\.cliEnv\(\)\)\|\|\{\}\)\}"""

proc envEndStateCount(s: string): int =
  s.findAll(envEndStateRe).len

# C. The two initialize-request fields, as the minifier spells them.
const INIT_SITES = [
  ("appendSystemPrompt:this.initConfig?.appendSystemPrompt",
   "appendSystemPrompt:((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.appendSystemPrompt)||function(x){return x})(this.initConfig?.appendSystemPrompt)"),
  ("agents:this.initConfig?.agents",
   "agents:((globalThis.__cdbCustomModels&&globalThis.__cdbCustomModels.agents)||function(x){return x})(this.initConfig?.agents)")
]

proc initSitesDone(s: string): int =
  ## How many of the C sites carry our end-state (0, 1 or 2).
  for site in INIT_SITES:
    if site[1] in s: inc result

const EXPECTED_PATCHES = 3  # A, B, C

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc buildInjection(): string =
  if PLACEHOLDER notin MAIN_JS:
    raise newException(ValueError, "custom_models_main.js lost its preload-src placeholder")
  MAIN_JS.replace(PLACEHOLDER, "\"" & escapeJs(PRELOAD_JS) & "\"")

proc apply*(input: string): string =
  result = input
  var patchesApplied = 0

  # A. main module injection. Idempotency: positive end-state (Rule 6).
  if MARKER in result:
    echo "  [OK] custom models: main module already present (idempotent)"
    inc patchesApplied
  else:
    let injection = buildInjection()
    let strictPrefix = "\"use strict\";"
    if result.startsWith(strictPrefix):
      result = strictPrefix & injection & result[strictPrefix.len .. ^1]
      echo "  [OK] custom models: main module injected after \"use strict\""
    else:
      result = injection & result
      echo "  [OK] custom models: main module prepended"
    if MARKER in result:
      inc patchesApplied
    else:
      echo "  [FAIL] custom models: main module not present after injection"

  # B. CLI environment splice. Exactly one CCD session env object.
  let already = envEndStateCount(result)
  if already == 1:
    echo "  [OK] custom models: CLI env splice already present (idempotent)"
    inc patchesApplied
  elif already > 1:
    echo "  [FAIL] custom models: env splice present " & $already & " times, expected 1 - re-audit"
  else:
    var count = 0
    result = result.replace(
      envSiteRe,
      proc(m: RegexMatch2, s: string): string =
        inc count
        s[m.group(0)] & ENV_SPLICE,
    )
    if count != 1:
      echo "  [FAIL] custom models: expected exactly 1 base session env site " &
        "(DISABLE_MICROCOMPACT:\"1\",NODE_USE_SYSTEM_CA:\"1\"}), found " & $count &
        " - the Code session env object moved; re-audit sub-patch B"
    elif envEndStateCount(result) != 1:
      echo "  [FAIL] custom models: env splice missing after replacement"
    else:
      echo "  [OK] custom models: cliEnv() spliced into the Code session env (1 match)"
      inc patchesApplied

  # C. Sub-agent definitions and the system-prompt suffix of the initialize
  # request. Both sites or nothing: half a patch would list the types in the
  # system prompt without defining them, or the reverse.
  let done = initSitesDone(result)
  if done == INIT_SITES.len:
    echo "  [OK] custom models: initialize request already routed (idempotent)"
    inc patchesApplied
  elif done > 0:
    echo "  [FAIL] custom models: " & $done & "/" & $INIT_SITES.len & " initialize sites already patched - re-audit"
  else:
    var siteOk = true
    for site in INIT_SITES:
      let n = result.count(site[0])
      if n != 1:
        echo "  [FAIL] custom models: expected exactly 1 initialize site `" & site[0] & "`, found " & $n &
          " - the session initialize request moved; re-audit sub-patch C"
        siteOk = false
    if siteOk:
      var patched = result
      for site in INIT_SITES:
        patched = patched.replace(site[0], site[1])
      if initSitesDone(patched) != INIT_SITES.len:
        echo "  [FAIL] custom models: initialize sites missing after replacement"
      else:
        result = patched
        echo "  [OK] custom models: agents() and appendSystemPrompt() routed through the initialize request (2 sites)"
        inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES & " patches applied"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_feature_custom_models <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_feature_custom_models ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] custom models applied"
  else:
    if MARKER notin output or envEndStateCount(output) != 1 or initSitesDone(output) != INIT_SITES.len:
      echo "  [FAIL] No changes made and injection is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
