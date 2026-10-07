# @patch-target: resources/ion-dist
# @patch-type: nim-dir
#
# Setup-window half of "Allow non-Anthropic models" (the main-process half is
# add_feature_allow_non_anthropic_models.nim): relaxes the ion-dist SPA's own
# copy of the gateway model-name check, opt-in (default OFF).
#
# Developer -> Configure Third-Party Inference (app://localhost/setup-desktop-3p)
# is the ion-dist React SPA. It validates the Model list in the RENDERER with
# its own copy of upstream's per-provider validator (no IPC to main for this):
#   - per-row warning: the inferenceModels field predicate
#     `warn:(e,t,n)=>is(e.name,t,n)` -> `Cr(provider,name)` -> "Doesn't look
#     like an Anthropic model: {reason}"
#   - Apply block: the config diagnostic `df` (`lt` export) runs
#     `rs(cfg, ...)`, which pushes a `kind:"model", severity:"error"` issue per
#     rejected row; the wizard counts it as blocking -> "Invalid: Model list"
#     and a disabled Apply Changes.
# Both reach the gateway/mantle branch of `Cr`, the one-line validator pinned
# here by its reason string ("expected a gateway model route ..."). Guarding it
# covers both, exactly like sub-patch B of the main-process patch does for its
# twin `HCe`. The anthropic / bedrock / vertex / foundry validators are not
# touched.
#
# Signal: the main patch (sub-patch E) adds
# `cdbAllowNonAnthropicModels:{status:"supported"}` to the `--desktop-features`
# JSON of the setup window's additionalArguments ONLY when the switch is on.
# Upstream's preload (mainView.js) parses that argument and exposes it with
# contextBridge as `window.desktopBootFeatures` before any page script runs, so
# the value is there synchronously the first time the validator runs (no IPC,
# no race). Switch off or the main half missing -> the key is absent -> the
# guard is false -> `Sr` behaves exactly as stock.
#
#   function Sr(e){return /*cdb-mb:ion-validator*/GUARD||_r(e)?{ok:!0}:{ok:!1,reason:"expected a gateway model route ..."}}
#   (`||` binds tighter than `?:`: a true guard accepts, else stock.)
#
# The SPA files have content-hashed names, so the site is found by content
# across assets/v1/*.js; exactly one site (upstream shape or our end state) must
# exist across the whole SPA, anything else FAILs.

import std/[os, strutils]
import regex

const MARK = "/*cdb-mb:ion-validator*/"
const GUARD =
  "(globalThis.desktopBootFeatures?.cdbAllowNonAnthropicModels?.status===\"supported\")"
const EXPECTED_PATCHES = 1 # A gateway validator

const sitePat =
  re2"""(function [\w$]+\([\w$]+\)[{]return )([\w$]+\([\w$]+\)\?[{]ok:!0[}]:[{]ok:!1,reason:["`]expected a gateway model route referencing an Anthropic model)"""

iterator spaFiles(ionDistDir: string): string =
  for dir in walkDir(ionDistDir / "assets" / "v1"):
    if dir.kind == pcFile and dir.path.endsWith(".js"):
      yield dir.path

proc main() =
  if paramCount() != 1:
    echo "Usage: add_feature_allow_non_anthropic_models_ion <ion-dist-directory>"
    quit(1)
  let ionDistDir = paramStr(1)
  echo "=== Patch: add_feature_allow_non_anthropic_models_ion ==="
  echo "  Target dir: " & ionDistDir
  if not dirExists(ionDistDir):
    echo "  [FAIL] Directory not found: " & ionDistDir
    quit(1)

  # Pass 1: count upstream sites and our end state across every SPA file.
  var oldA, newA, guardTotal = 0
  for filePath in spaFiles(ionDistDir):
    let content = readFile(filePath)
    oldA += content.findAll(sitePat).len
    newA += content.count(MARK & GUARD & "||")
    guardTotal += content.count(GUARD)

  var patchesApplied = 0
  if oldA == 0 and newA == 1 and guardTotal == 1:
    # Rule 6: positive end-state - our marked guard is present exactly once.
    echo "  [OK] ion gateway model validator: guard already present (idempotent)"
    echo "  [PASS] Already applied (" & $EXPECTED_PATCHES & "/" & $EXPECTED_PATCHES &
      " parts)"
    quit(0)
  if oldA != 1 or newA != 0 or guardTotal != 0:
    echo "  [FAIL] ion gateway model validator: " & $oldA & " upstream and " & $newA &
      " patched sites (guard text x" & $guardTotal &
      ") across the SPA, expected exactly one upstream site - re-audit"
    quit(1)

  # Pass 2: splice the one file that holds the site.
  for filePath in spaFiles(ionDistDir):
    let content = readFile(filePath)
    if content.findAll(sitePat).len != 1:
      continue
    var n = 0
    let patched = content.replace(
      sitePat,
      proc(m: RegexMatch2, s: string): string =
        inc n
        s[m.group(0)] & MARK & GUARD & "||" & s[m.group(1)],
    )
    if n == 1 and patched.count(MARK & GUARD & "||") == 1:
      writeFile(filePath, patched)
      echo "  [OK] ion gateway model validator: guard added (" &
        extractFilename(filePath) & ")"
      inc patchesApplied

  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)
  echo "  [PASS] All " & $EXPECTED_PATCHES & " patches applied"
  quit(0)

when isMainModule:
  main()
