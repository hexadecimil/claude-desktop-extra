# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Suffix the main window title with the active profile name when CLAUDE_PROFILE
# is set. "Claude" → "Claude (work)" so users can tell windows apart in
# Alt-Tab, taskbar tooltips, and screenshots without relying on icon shape.
#
# How it works:
#   - The main window is constructed by the unsuffixed-named function
#     `function NAME(arg){return WIN=new ELECTRON.BrowserWindow(arg),...}`.
#   - Since v2.19675.1 upstream drives the main-window title itself: it
#     preventDefaults the window's page-title-updated and calls
#     win.setTitle(composed) on did-navigate, on a debounced claude.ai
#     page-title-updated, and when GrowthBook flag 3052534774 flips.
#   - We inject a tiny comma-expression right after the BrowserWindow
#     construction that, when CLAUDE_PROFILE is set, wraps THIS window's
#     setTitle so every title (ours or upstream's) ends with " (PROFILE)"
#     exactly once and re-applies the current title. Electron's native
#     page-title-updated path bypasses JS setTitle, so the patch also
#     asserts upstream's sync (preventDefault + setTitle) is still there.
#     "Claude" -> "Claude (work)", "My chat - Claude" -> "My chat - Claude (work)".
#
# Default profile (CLAUDE_PROFILE unset) → no listener attached, no behavior
# change.
#
# Break risk: LOW. Targets the standard Electron BrowserWindow API with
# flexible regex on minified variable names.

import std/[os, strformat, strutils]
import std/nre

const SENTINEL = "__cdb_titleHook"

proc apply*(input: string): string =
  result = input

  if SENTINEL in result:
    echo "  [INFO] Window title hook already applied"
    echo "  [PASS] No changes needed (already patched)"
    return

  # Precondition: upstream's main-window title sync owns the title
  # (`win.on("page-title-updated",e=>{e.preventDefault()})` + a
  # `win.setTitle(...)` driver). Without it Electron applies page titles
  # natively, bypassing our setTitle wrapper, and the suffix would be lost.
  let syncPattern =
    re"""function [\w$]+\(([\w$]+),[\w$]+\)\{let [\w$]+,[\w$]+,[\w$]+=\(\)=>\{if\(\1\.isDestroyed\(\)\)return;let [\w$]+=[\w$]+\([^;]*;[^}]*\1\.setTitle\([\w$]+\)\)\}[^;]*;?[^\n]{0,200}?\1\.on\(["`]page-title-updated["`],\(?([\w$]+)\)?=>\{?\2\.preventDefault\(\)"""
  var syncHits = 0
  for _ in result.findIter(syncPattern):
    inc syncHits
  if syncHits != 1:
    echo &"  [FAIL] upstream main-window title sync: {syncHits} matches, expected 1"
    raise newException(
      ValueError, "fix_profile_window_title: title sync not found - re-audit"
    )
  echo "  [OK] upstream main-window title sync present (1 match)"

  # function NAME(ARG){return WIN=new ELECTRON.BrowserWindow(ARG),
  # WIN may be a dotted property path since v1.19367.0 (`exports.mainWindow`).
  let pattern =
    re"function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+(?:\.[\w$]+)*)=new ([\w$]+)\.BrowserWindow\(\2\),"

  var hits = 0
  result = result.replace(
    pattern,
    proc(m: RegexMatch): string =
      inc hits
      let funcName = m.captures[0]
      let argName = m.captures[1]
      let winVar = m.captures[2]
      let electronVar = m.captures[3]
      "function " & funcName & "(" & argName & "){return " & winVar & "=new " &
        electronVar & ".BrowserWindow(" & argName & ")," &
        # Profile-aware title injection. Wrapped in a single short-circuit
        # expression so the comma chain still type-checks; evaluates to
        # `false` (no-op) when CLAUDE_PROFILE is unset.
        #
        # Since v2.19675.1 upstream owns the main-window title (it
        # preventDefaults page-title-updated and calls win.setTitle() from
        # did-navigate / a debounced page-title-updated / a GrowthBook
        # listener). A one-shot setTitle would be overwritten, so we wrap
        # THIS window's setTitle: every title, ours or upstream's, gets the
        # suffix exactly once. Other windows keep their own setTitle.
        "process.env.CLAUDE_PROFILE&&((globalThis." & SENTINEL &
        "=true),((__cdb_w,__cdb_s)=>{" & "const __cdb_o=__cdb_w.setTitle.bind(__cdb_w);" &
        "__cdb_w.setTitle=(__cdb_t)=>{__cdb_t=String(__cdb_t??\"\");" &
        "return __cdb_o(__cdb_t.endsWith(__cdb_s)?__cdb_t:__cdb_t+__cdb_s)};" &
        "__cdb_w.setTitle(__cdb_w.getTitle())})(" & winVar &
        ",\" (\"+process.env.CLAUDE_PROFILE+\")\")),",
  )

  if hits == 1:
    echo &"  [OK] Main window title hook injected (function={hits} match)"
  elif hits > 1:
    # Defensive: should be exactly one main-window-construction site. If the
    # pattern starts matching multiple BrowserWindow factories, that's a
    # signal upstream changed shape and we should investigate rather than
    # silently inject into windows that already lock their title.
    echo &"  [FAIL] Expected 1 BrowserWindow construction site, got {hits}"
    raise newException(ValueError, "fix_profile_window_title: ambiguous match")
  else:
    echo "  [FAIL] Main window construction pattern not found"
    raise newException(ValueError, "fix_profile_window_title: 0 matches")

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_profile_window_title <file>"
    quit(1)

  let filePath = paramStr(1)
  echo "=== Patch: fix_profile_window_title ==="
  echo "  Target: " & filePath

  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)

  let input = readFile(filePath)
  let output = apply(input)

  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Profile window title hook installed"
  # If unchanged, apply() already printed [PASS] for the already-applied case.
