# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Parent side of the M365 OAuth browser-open delegation (issue #139, KDE).
#
# The built-in MCP host's parent<->child message handler (a flat if-chain that
# only knows msal-cache-get / msal-cache-set, wired via
# this.process.on("message", ...)) gains a new first branch:
#
#   {type:"open-url", url:"https://..."}  ->  shell.openExternal(url)
#
# This is the exact mechanism the remote-OAuth (Atlassian) flow uses, which is
# why that connector opens the browser fine on every DE while the local M365
# connector's in-child spawn("xdg-open") fails on KDE. The child side is
# patched by fix_office365_mcp_open_url.nim; both are required together.
#
# Safety: the branch only accepts string URLs starting with https:// so a
# compromised MCP child cannot open file:// or other schemes via the parent.
#
# Anchors: the unique "msal-cache-get" literal for the injection site. The
# electron module is reached via `require("electron")` at the injection site
# rather than the chunk's minified electron var: since v2.26454.0 the handler is
# `(n,a)=>{...}` inside a function that also binds `a`, while the chunk's
# electron var is `a` too, so any recovered chunk-level name can be shadowed.
# `require` is the chunk's own CJS require (the chunk head does
# `let a=require("electron")`), never shadowed by minified locals.
# All minified identifiers ([\w$]+) are captured and reused.

import std/os
import regex

proc apply*(input: string): string =
  # Idempotency: positive end-state -- the open-url branch must be present.
  if input.contains(
    re2"""===["`]open-url["`]&&typeof [\w$]+\.url==["`]string["`]&&[\w$]+\.url\.startsWith\(["`]https://["`]\)\)\{require\(["`]electron["`]\)\.shell\.openExternal\("""
  ):
    echo "  [OK] built-in MCP open-url handler: already patched"
    return input

  # Inject the branch at the head of the child-message if-chain.
  # Matches (v1.20186.1): };return(d,f)=>{const p=d;if((p==null?void 0:p.type)==="msal-cache-get"
  # Matches (v1.26832.0): };return(a,c)=>{let u=a;if(u?.type===`msal-cache-get`
  # Matches (v2.26454.0): };return Object.assign(((n,a)=>{let o=n;if(o?.type==="msal-cache-get"
  # The v1.26832.0 minifier switched to `let`, native optional chaining instead
  # of the (x==null?void 0:x.y) desugaring, and backtick template literals - all
  # three are accepted below so the patch spans every bundle shape. v2.26454.0
  # wraps the handler as `Object.assign(<handler>,{holdsAccount:...})`; the
  # handler body (where we inject) is unchanged.
  # Groups: 0=head incl. "let p=d;", 1=message param, 2=message var,
  # 3=original if-head.
  let pattern =
    re2"""(\};return(?:\(| Object\.assign\(\(\()([\w$]+),[\w$]+\)=>\{(?:const|let|var) ([\w$]+)=[\w$]+;)(if\((?:\([\w$]+==null\?void 0:[\w$]+\.type\)|[\w$]+\?\.type)===["`]msal-cache-get["`])"""

  var count = 0
  result = input.replace(
    pattern,
    proc(m: RegexMatch2, s: string): string =
      inc count
      let head = s[m.group(0)]
      let msgVar = s[m.group(2)]
      let ifHead = s[m.group(3)]
      head & "if((" & msgVar & "==null?void 0:" & msgVar &
        ".type)===\"open-url\"&&typeof " & msgVar & ".url==\"string\"&&" & msgVar &
        ".url.startsWith(\"https://\")){require(\"electron\").shell.openExternal(" &
        msgVar & ".url).catch(()=>{});return}" & ifHead,
  )

  if count != 1:
    echo "  [FAIL] built-in MCP open-url handler: found " & $count &
      " msal-cache-get injection sites (expected 1)"
    quit(1)

  echo "  [OK] built-in MCP open-url handler: shell.openExternal branch added"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: fix_builtin_mcp_open_url_handler <file>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: fix_builtin_mcp_open_url_handler ==="
  echo "  Target: " & filePath
  let input = readFile(filePath)
  let output = apply(input)
  writeFile(filePath, output)
  echo "  [PASS] built-in MCP open-url handler patched successfully"
