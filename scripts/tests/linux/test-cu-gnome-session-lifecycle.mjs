// Regression test for the GNOME portal session lifecycle in js/cu_linux_executor.js.
//
// The CU lock hook (patches 4b / 4b.2 of fix_computer_use_linux.nim) calls
// __setLockHeld(true|false) FIRE-AND-FORGET on every lock transition. The portal
// session behind it is expensive to start: on GNOME the first session-start blocks
// on the XDG RemoteDesktop consent dialog. Two orderings have to hold or the
// gnome-portal-bridge daemon is left running, or a second consent dialog is raised:
//
//   A  a release that arrives while session-start is still pending must WAIT for
//      that start and then really end the session. Otherwise session-end runs
//      first, the start resolves afterwards and re-marks the session active with
//      no lock held - the daemon then survives to the process exit backstop.
//   B  a lock RE-ACQUIRED while a release is still awaiting that start must not
//      produce a second concurrent session-start. Otherwise two consent dialogs
//      are raised and the stale end tears down what the new lock asked for,
//      leaving _gnomeSessionActive true against a dead session.
//   C  the double release (4b.2 deliberately hooks both release and
//      releaseExclusive) must collapse to one teardown.
//
// The KDE twin in js/executor_linux.js has had both halves of this - a synchronous
// flag write plus a published stop promise that starts await - since it was
// written; this file is the GNOME side catching up. Run headless: the bridge is a
// stub, no portal and no GNOME needed.
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const EXECUTOR = path.join(ROOT, "js", "cu_linux_executor.js");

// session-start takes CONSENT_MS (the XDG RemoteDesktop dialog); everything else is instant.
function makeRig(consentMs) {
  const log = [];
  const cp = {
    execFileSync(bin, args) {
      const base = path.basename(String(bin));
      if (base === "which" || base === "systemd-detect-virt" || base === "pgrep") throw new Error("not found");
      log.push("SYNC " + base + " " + (args || []).join(" "));
      throw new Error("sync not expected");
    },
    execSync() { throw new Error("nope"); },
    spawnSync() { return { status: 1 }; },
    execFile(bin, args, opts, cb) {
      const base = path.basename(String(bin));
      const sub = (args || [])[0];
      log.push("CALL " + sub);
      const delay = sub === "session-start" ? consentMs : 0;
      setTimeout(() => { log.push("DONE " + sub); cb(null, "{}", ""); }, delay);
    },
    spawn() { return { on() {}, unref() {} }; }
  };
  const electron = {
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1, bounds: {x:0,y:0,width:1,height:1}, workArea:{x:0,y:0,width:1,height:1}, scaleFactor:1, label:"e" }), getCursorScreenPoint: () => ({x:0,y:0}) },
    desktopCapturer: { getSources: async () => [] },
    clipboard: { readText: () => "", writeText: () => {} },
    nativeImage: {}
  };
  const requireStub = (id) => {
    if (id === "child_process") return cp;
    if (id === "electron") return electron;
    if (id === "path") return path;
    if (id === "os") return os;
    if (id === "fs") return { readFileSync: () => Buffer.alloc(0), writeFileSync(){}, unlinkSync(){}, existsSync: () => false, renameSync(){}, accessSync(){ throw new Error("no"); }, readdirSync: () => [], statSync: () => ({ isDirectory: () => false }) };
    throw new Error("unexpected require " + id);
  };
  globalThis.__cdbDiag = (m) => log.push("DIAG " + String(m));
  globalThis.__cuGnomeBridgeBin = "/res/gnome-portal-bridge";
  globalThis.__cuKwinMode = false;
  process.env.XDG_CURRENT_DESKTOP = "ubuntu:GNOME";
  process.env.XDG_SESSION_TYPE = "wayland";
  process.env.WAYLAND_DISPLAY = "wayland-0";
  delete process.env.SWAYSOCK; delete process.env.HYPRLAND_INSTANCE_SIGNATURE; delete process.env.NIRI_SOCKET;
  delete process.env.GNOME_PORTAL_BRIDGE_BIN;
  const src = readFileSync(EXECUTOR, "utf8");
  new Function("require", "process", src)(requireStub, process);
  const ex = globalThis.__linuxExecutor;
  log.length = 0;
  return { ex, log, restore(){ delete globalThis.__linuxExecutor; } };
}


const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS " + label + (extra ? "  -> " + extra : "")); return; }
  fail++; console.error("  FAIL " + label + (extra ? "  -> " + extra : ""));
}
const calls = (log) => log.filter(l => l.startsWith("CALL") || l.startsWith("DONE"));

console.log("\n[1] a release arriving during a pending session-start waits for it");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  await rig.ex.__setLockHeld(false);
  await sleep(300);
  const seq = calls(rig.log);
  ok(seq.join("|") === "CALL session-start|DONE session-start|CALL session-end|DONE session-end",
     "session-end is issued only after the pending start resolved", seq.join(" "));
  ok(rig.log.some(l => l.includes("waiting for an in-flight session-start")),
     "and the wait is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[2] a lock re-acquired mid-teardown does not open a second session");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);
  await sleep(10);
  rig.ex.__setLockHeld(true);
  await sleep(500);
  const seq = calls(rig.log);
  ok(seq.filter(l => l === "CALL session-start").length === 1 ||
     seq.indexOf("CALL session-end") < seq.lastIndexOf("CALL session-start"),
     "the second start is queued BEHIND the end, never concurrent with it", seq.join(" "));
  const firstEnd = seq.indexOf("CALL session-end");
  const startsBeforeEnd = seq.slice(0, firstEnd).filter(l => l === "CALL session-start").length;
  ok(startsBeforeEnd === 1, "exactly one session-start is in flight before the teardown",
     String(startsBeforeEnd));
  ok(seq[seq.length - 1] === "DONE session-start",
     "and the run ends with the session UP, matching the lock that is held", seq.join(" "));
  rig.restore();
}

console.log("\n[3] the double release collapses to a single teardown");
{
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);
  rig.ex.__setLockHeld(false);
  await sleep(500);
  const seq = calls(rig.log);
  ok(seq.filter(l => l === "CALL session-end").length === 1,
     "release + releaseExclusive issue session-end once, not twice", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "and the session is left DOWN, matching the released lock", seq.join(" "));
  rig.restore();
}

console.log("\n[4] a release cancels a start that is only QUEUED behind a teardown");
{
  // end -> start (queued, nothing running yet) -> end. The queued continuation
  // must consult the intent flag, not start unconditionally. Getting this wrong
  // leaves the portal session UP with no lock held, i.e. a live
  // RemoteDesktop/ScreenCast grant while the user believes CU is idle.
  const rig = makeRig(120);
  rig.ex.__setLockHeld(true);
  await sleep(10);
  rig.ex.__setLockHeld(false);   // teardown begins, parks on the pending start
  await sleep(5);
  rig.ex.__setLockHeld(true);    // queued behind the teardown
  await sleep(5);
  rig.ex.__setLockHeld(false);   // released again before the queue drains
  await sleep(600);
  const seq = calls(rig.log);
  const starts = seq.filter(l => l === "CALL session-start").length;
  ok(starts === 1, "no session is started after the final release", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "the run ends with the session DOWN, matching the released lock", seq.join(" "));
  ok(rig.log.some(l => l.includes("queued session-start cancelled")),
     "and the cancellation is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[5] the ORDINARY lifecycle: start completes, then the lock is released");
{
  // The most common ordering in production and the easiest to leave uncovered:
  // every other case here releases while the start is still pending, so
  // _gnomeSessionStarting is non-null and any skip guard keyed on it is bypassed.
  // Here the start has fully settled, so the teardown has to decide on the
  // session flag alone. Getting that wrong means the portal session and the
  // gnome-portal-bridge daemon survive every single lock release.
  const rig = makeRig(20);
  rig.ex.__setLockHeld(true);
  await sleep(200);                 // let session-start fully settle
  await rig.ex.__setLockHeld(false);
  await sleep(300);
  const seq = calls(rig.log);
  ok(seq.includes("CALL session-end"),
     "a release after a completed start still ends the session", seq.join(" "));
  ok(seq[seq.length - 1] === "DONE session-end",
     "and the run ends with the session DOWN", seq.join(" "));
  ok(rig.log.some(l => l.includes("session ended")),
     "and the teardown is reported in the diagnostics log");
  rig.restore();
}

console.log("\n[6] a release with nothing ever started does not spawn session-end");
{
  const rig = makeRig(20);
  await rig.ex.__setLockHeld(false);   // released without ever acquiring
  await sleep(200);
  const seq = calls(rig.log);
  ok(seq.length === 0, "no bridge subprocess is spawned at all", seq.join(" ") || "(none)");
  rig.restore();
}

console.log("\n" + (fail ? `${pass} passed, ${fail} FAILED` : `ALL ${pass} CHECKS PASSED`));
process.exit(fail ? 1 : 0);
