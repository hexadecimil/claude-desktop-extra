/* __cdb_tray_host_v1__
   Tray-host detection for upstream's hidden-launch path.

   Inlined by patches/linux/fix_tray_less_desktops.nim as a bare expression.
   It evaluates to one shared object (globalThis.__cdbTrayHost) with:
     startup(visibleAtLaunch, showMainWindow, trayEnabled)
       called right after upstream creates the main window. When the window
       was born hidden (a --startup / autostart launch) and there is no tray
       to get it back from, it calls upstream's own showMainWindow.
     state()
       "pending" | "present" | "absent" | "unknown" (for tests / diagnostics).

   Why: upstream creates the main window hidden on --startup and relies on
   the tray icon to bring it back. On a Wayland session without an
   org.kde.StatusNotifierWatcher (vanilla GNOME without AppIndicator,
   sway/niri without a tray-capable bar) the Electron Tray has nowhere to go,
   so the app becomes an invisible process. Closing the window on such a
   desktop is handled by upstream itself (it quits).

   Decision table for a hidden launch (FAIL-SAFE DIRECTION IS UPSTREAM
   BEHAVIOR, i.e. stay hidden):
     watcher on the bus                  -> stays hidden (upstream)
     probe pending / no tool / bus error -> stays hidden (upstream)
     X11 session, no watcher             -> stays hidden (upstream). Electron
                                            then falls back to an XEmbed
                                            GtkStatusIcon, which an XEmbed tray
                                            (i3bar, tint2, ...) can host, and
                                            that tray is invisible to the bus.
     Wayland session, no watcher         -> shown
   Independently: a hidden launch while the tray is switched off in settings
   is shown, because upstream creates no tray icon in that case at all.

   The probe asks the bus daemon NameHasOwner(org.kde.StatusNotifierWatcher),
   once per process, asynchronously (never blocks the main process). There is
   no D-Bus client in the bundle, so it spawns a CLI from PATH in the same
   fallback order as the launcher: busctl -> dbus-send -> gdbus. No absolute
   paths, so it works on NixOS, non-systemd distros and AppImage alike. A tool
   that is missing or cannot answer falls through to the next.

   Comments in this file are block comments only: it is inlined into minified
   code where a line comment would swallow what follows. */
(() => {
  const G = globalThis;
  if (G.__cdbTrayHost) return G.__cdbTrayHost;
  const diag = (s) => {
    try {
      (G.__cdbDiag || console.log)("[tray-host] " + s);
    } catch (e) {}
  };
  const env = process.env || {};
  const wayland =
    env.XDG_SESSION_TYPE === "wayland" ||
    (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "x11");
  const NAME = "org.kde.StatusNotifierWatcher";
  const BUS = "org.freedesktop.DBus";
  const PATH = "/org/freedesktop/DBus";
  const probes = [
    [
      "busctl",
      ["--user", "--no-pager", "--timeout=2", "call", BUS, PATH, BUS, "NameHasOwner", "s", NAME],
      (o) => (/^b\s+true\b/.test(o) ? true : /^b\s+false\b/.test(o) ? false : null),
    ],
    [
      "dbus-send",
      ["--session", "--print-reply", "--reply-timeout=2000", "--dest=" + BUS, PATH, BUS + ".NameHasOwner", "string:" + NAME],
      (o) => (/boolean\s+true\b/.test(o) ? true : /boolean\s+false\b/.test(o) ? false : null),
    ],
    [
      "gdbus",
      ["call", "--session", "--timeout", "2", "--dest", BUS, "--object-path", PATH, "--method", BUS + ".NameHasOwner", NAME],
      (o) => (/^\(true,?\)/.test(o) ? true : /^\(false,?\)/.test(o) ? false : null),
    ],
  ];
  let st = "pending";
  const waiters = [];
  const settle = (s, why) => {
    st = s;
    diag(
      "StatusNotifierWatcher " + s + " (" + why + "), session=" +
        (wayland ? "wayland" : "x11") + " -> " +
        (s === "absent" && wayland
          ? "no tray host: a hidden launch is shown"
          : "upstream tray behavior unchanged")
    );
    waiters.splice(0).forEach((f) => {
      try {
        f();
      } catch (e) {}
    });
  };
  const run = (i) => {
    if (i >= probes.length) return settle("unknown", "no bus tool could answer");
    const [bin, args, parse] = probes[i];
    try {
      require("child_process").execFile(
        bin,
        args,
        { timeout: 3000, encoding: "utf8" },
        (err, out) => {
          const v = err ? null : parse(String(out || "").trim());
          if (v === null) return run(i + 1);
          settle(v ? "present" : "absent", "via " + bin);
        }
      );
    } catch (e) {
      run(i + 1);
    }
  };
  const missing = () => wayland && st === "absent";
  const api = {
    state: () => st,
    startup(visible, show, trayEnabled) {
      if (visible) return;
      const doShow = (why) => {
        diag("hidden launch (" + why + ") - showing the main window");
        setTimeout(() => {
          try {
            show();
          } catch (e) {
            diag("showMainWindow failed: " + (e && e.message));
          }
        }, 0);
      };
      let enabled = true;
      try {
        enabled = trayEnabled() !== false;
      } catch (e) {}
      if (!enabled) return doShow("tray switched off in settings");
      const decide = () => {
        if (missing()) doShow("no tray host on the bus");
      };
      if (st === "pending") waiters.push(decide);
      else decide();
    },
  };
  G.__cdbTrayHost = api;
  run(0);
  return api;
})()
