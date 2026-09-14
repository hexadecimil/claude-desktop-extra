/*
 * custom_models_main.js - main-process half of the custom models feature.
 *
 * Lists models served by an Anthropic-COMPATIBLE endpoint (DeepSeek's
 * /anthropic API is the reference) in the Code tab's model picker, NEXT TO
 * Anthropic's own models, and routes the CLI's requests for them to that
 * endpoint with the provider's key. The subscription login and every Claude
 * model are untouched: this is additive, unlike the 3p/managed-settings mode,
 * which is exclusive.
 *
 * Two halves, both driven by the `customModels` key of
 * <userData>/claude-desktop-extra.jsonc (hand-owned, wins) / .json (UI):
 *
 *  1. PICKER. The page (remote claude.ai code) builds its model menu from
 *     `model_selector_config` in the /api/bootstrap response and then tells
 *     the app which ids exist (setAvailableCodeModels). Nothing local feeds
 *     that menu - modelPicker in ~/.claude/settings.json only reaches the CLI's
 *     own /model. So we attach the Chrome DevTools Protocol `Fetch` domain to
 *     claude.ai webContents, pause the bootstrap RESPONSE, and append our
 *     entries to the surfaces we are configured for (default: ccd and code,
 *     the two the desktop Code tab reads - see DEFAULT_SURFACES). The entries
 *     copy the shape the live bootstrap carries for that surface (see the
 *     picker-entries section), so the page renders them like any other
 *     model. Anthropic's list stays whatever the server sent - new Claude
 *     models keep appearing.
 *
 *  2. ROUTING. `cliEnv()` is spliced into the environment of every Code-tab
 *     session the app spawns (sub-patch B of the Nim patch): BUN_OPTIONS
 *     loads js/custom_models_preload.js inside the Claude Code binary, and
 *     CDB_CUSTOM_MODELS_JSON carries the resolved providers (endpoint, key,
 *     models). The preload hooks fetch there and forwards only our models.
 *     The app's own validator accepts any id in subscription mode; the CLI's
 *     accepts ^claude-\S+$, hence every custom id is exposed as "claude-<id>".
 *
 *  3. SUB-AGENTS. `agents()` and `appendSystemPrompt()` are routed through
 *     the session's `initialize` request (sub-patch C): one sub-agent type
 *     per model, so Claude can launch it by name (Agent tool, workflow
 *     agentType), and one system-prompt line that tells Claude the ids and
 *     the types exist. CLAUDE_CODE_SUBAGENT_MODEL, when the user picks a
 *     default sub-agent model, rides in cliEnv().
 *
 * SECURITY: the provider key never reaches the page - the bootstrap patch
 * carries names and ids only. The IPC handlers validate the sender ORIGIN
 * (not a substring of the URL) and take only a boolean; nothing page-supplied
 * reaches the filesystem. The key travels to the CLI in its environment, the
 * same channel the app uses for its own credentials in 3p mode, and the
 * preload deletes it from process.env before the CLI's code runs so no child
 * process (Bash tool, MCP servers) inherits it.
 */
;/*__CDB_CUSTOM_MODELS__*/(function () {
  "use strict";
  if (typeof process === "undefined" || process.platform !== "linux") return;
  if (globalThis.__cdbCustomModels) return;

  var _electron = require("electron");
  var _app = _electron.app;
  var _ipc = _electron.ipcMain;
  var _fs = require("fs");
  var _path = require("path");
  var _os = require("os");
  var _URL = require("url").URL;

  var PRELOAD_SRC = "__CDB_CM_PRELOAD_SRC__";
  var PREF_KEY = "customModels";
  var JSONC_NAME = "claude-desktop-extra.jsonc";
  var JSON_NAME = "claude-desktop-extra.json";
  var SUBDIR = "custom-models";
  var PRELOAD_NAME = "preload.js";
  var LOG_NAME = "custom-models.log";
  var SECRETS_NAME = "secrets.json";
  // What the preload routes with, rewritten at every change of the
  // configuration and re-read by the CLI sessions already open (live routing):
  // the resolved providers WITH their keys, 0600 in the 0700 subdir - the same
  // exposure as secrets.json. Empty when the feature is off.
  var ROUTES_NAME = "routes.json";
  // Picker surfaces as the bootstrap names them. The desktop Code tab reads
  // TWO of them: `ccd` is the catalogue the picker menu is drawn from, `code`
  // is the surface the session logic runs on - the model's effort options
  // (the effort menu is hidden for a model `code` does not list), the ids
  // reported to the app as available (setAvailableCodeModels, hence what the
  // set_session_model MCP tool accepts) and the state the page persists
  // (PATCH model_selector_state/code). Both are needed. `ccr` is Claude Code
  // on the web, then chat/cowork/design/... - a Cowork session runs in a VM
  // and cannot reach the preload, so those are not listed by default.
  var DEFAULT_SURFACES = ["ccd", "code"];
  // How a model is exposed to the CLI, which trusts only the id for its
  // context window: anything it does not know is 200k, unless the id ends in
  // "[1m]" (the spelling it uses for Sonnet/Opus 1M) - then 1M. The window
  // drives the context gauge and auto-compaction, so a natively-1M model
  // listed under its bare id is compacted at 200k.
  //   "200k": listed as claude-<id>
  //   "1m":   listed as claude-<id>[1m] only, under its plain name
  //   "both": claude-<id> and claude-<id>[1m] ("<name> 1M"), the way Sonnet
  //           and Opus 1M are offered - for a provider that prices the two
  //           windows differently
  var CONTEXT_MODES = ["200k", "1m", "both"];
  var DEFAULT_CONTEXT = "200k";
  var SURFACE_RE = /^[a-z][a-z0-9_]{0,40}$/;
  var ID_PREFIX = "claude-";
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,120}$/;
  var PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
  // An Anthropic model id as the bootstrap lists them (claude-opus-5,
  // claude-haiku-4-5-20251001...): what the app-wide web-search choice may
  // name besides one of ours.
  var ANTHROPIC_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{0,60}$/;
  // Sub-agent types (see agentDefs): the name Claude launches a model's
  // sub-agent under - kebab-case, like the CLI's own general-purpose. The
  // reserved ones are the CLI's built-in types; a generated name that would
  // shadow one gets the provider id appended.
  var AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  var RESERVED_AGENT_NAMES = ["general-purpose", "explore", "plan", "claude", "fork", "statusline-setup", "claude-code-guide"];

  var DEBUG = process.env.CDB_CUSTOM_MODELS_DEBUG === "1";

  function log(m) { (globalThis.__cdbDiag || console.log)("[custom-models] " + m); }

  function userDir() {
    try { return _app.getPath("userData"); } catch (e) { return null; }
  }
  // Same nudge as every other config consumer (js/panel_tabs_main.js explains
  // why: the claude-desktop-bin.* -> claude-desktop-extra.* rename migration
  // may not have run yet when a same-anchor prefix injection gets here).
  function pathFor(name) {
    try { (globalThis.__cdbCfgMigrate || function () {})(); } catch (e) {}
    var d = userDir();
    return d ? _path.join(d, name) : null;
  }

  // Whole quoted strings are matched FIRST and passed through, so a "//"
  // inside a value (a URL - every baseUrl has one) is never taken for a comment.
  function stripComments(s) {
    return String(s)
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, function (m, q) { return q ? q : ""; })
      .replace(/,(\s*[}\]])/g, "$1");
  }
  // Lenient: any problem reads as "nothing set here". Nothing is written back
  // through this path (writePref does its own strict read).
  function readFileJson(p) {
    try {
      if (!p || !_fs.existsSync(p)) return null;
      var stripped = stripComments(_fs.readFileSync(p, "utf8"));
      var v = stripped.trim() ? JSON.parse(stripped) : {};
      return (v && typeof v === "object" && !Array.isArray(v)) ? v : null;
    } catch (e) { return null; }
  }
  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

  // ---- config ---------------------------------------------------------------
  // customModels: {
  //   enabled?: boolean,            // the switch; absent = on when a model is configured
  //   surfaces?: ["ccd", "code"],   // which pickers list them (bootstrap surface ids)
  //   webSearch?: "deepseek-flash", // app-wide: the CLI's web-search sub-request goes to
  //                                 // this model instead of Anthropic's small default - a
  //                                 // custom model, or any Anthropic id (claude-opus-5...)
  //   providers: [{
  //     id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic",
  //     apiKey | apiKeyEnv | apiKeyFile, headers?, effortMap?, context?,
  //     models: [{ id, name?, shortName?, description?, badge?, section?,
  //                context?, vision?, thinking?, webSearch?, effort?, effortDefault? }]
  //   }]
  // }
  // Two sources, merged: the hand-owned .jsonc and the .json the Settings
  // panel writes. `enabled` and `surfaces` come from the .jsonc when set there
  // (the switch then shows itself as locked), else from the .json. Providers
  // come from BOTH lists - a .jsonc provider is locked (the panel shows it,
  // cannot edit it) and wins over a .json provider with the same id.
  //
  // Keys the panel stores go to <userData>/custom-models/secrets.json (0600
  // in a 0700 dir), never into claude-desktop-extra.json - that file is
  // shared with every other extra, rewritten by their writers with default
  // permissions, and read by users who paste it into bug reports. A provider
  // whose key lives there carries apiKeyStored:true in the .json.
  var warned = Object.create(null);
  function warnOnce(key, msg) {
    if (warned[key]) return;
    warned[key] = true;
    log("config: " + msg);
  }

  function expandHome(p) {
    return typeof p === "string" && p.indexOf("~/") === 0 ? _path.join(_os.homedir(), p.slice(2)) : p;
  }
  function secretsPath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, SECRETS_NAME) : null;
  }
  function readSecrets() {
    var v = readFileJson(secretsPath());
    var out = Object.create(null);
    if (v) Object.keys(v).forEach(function (k) { if (typeof v[k] === "string") out[k] = v[k]; });
    return out;
  }
  function writeSecrets(map) {
    var p = secretsPath();
    if (!p) return { ok: false, error: "no userData path" };
    try {
      _fs.mkdirSync(_path.dirname(p), { recursive: true, mode: 448 });
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
      syncRoutes();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "cannot write " + p + ": " + (e && e.message ? e.message : String(e)) };
    }
  }
  // Returns { key, source } - source names where it came from, for the panel
  // and the logs; the value itself only ever reaches the CLI.
  function resolveKey(p, idx, secrets) {
    if (typeof p.apiKey === "string" && p.apiKey.trim()) return { key: p.apiKey.trim(), source: "value" };
    if (typeof p.apiKeyEnv === "string" && p.apiKeyEnv.trim()) {
      var v = process.env[p.apiKeyEnv.trim()];
      if (typeof v === "string" && v.trim()) return { key: v.trim(), source: "env" };
      warnOnce("keyenv" + idx, "provider " + p.id + ": apiKeyEnv " + p.apiKeyEnv + " is not set in the app's environment");
    }
    if (typeof p.apiKeyFile === "string" && p.apiKeyFile.trim()) {
      try { return { key: _fs.readFileSync(expandHome(p.apiKeyFile.trim()), "utf8").trim(), source: "file" }; }
      catch (e) { warnOnce("keyfile" + idx, "provider " + p.id + ": cannot read apiKeyFile (" + e.message + ")"); }
    }
    if (p.apiKeyStored === true && typeof secrets[p.id] === "string" && secrets[p.id]) {
      return { key: secrets[p.id], source: "stored" };
    }
    return { key: "", source: "none" };
  }

  function normaliseModel(raw, pid, idx) {
    if (!isObj(raw) || typeof raw.id !== "string" || !ID_RE.test(raw.id.trim())) {
      warnOnce("model" + pid + idx, "provider " + pid + ": models[" + idx + "] needs a plain string id - skipped");
      return null;
    }
    var id = raw.id.trim();
    var m = {
      id: id,
      alias: id.indexOf(ID_PREFIX) === 0 ? id : ID_PREFIX + id,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
      description: typeof raw.description === "string" ? raw.description.trim() : "",
      shortName: typeof raw.shortName === "string" && raw.shortName.trim() ? raw.shortName.trim() : "",
      badge: typeof raw.badge === "string" && raw.badge.trim() ? raw.badge.trim() : "",
      section: raw.section === "overflow" ? "overflow" : "main",
      vision: raw.vision !== false,
      thinking: raw.thinking !== false,
      webSearch: raw.webSearch !== false
    };
    if (Array.isArray(raw.effort)) {
      var lv = raw.effort.filter(function (x) { return EFFORT_ORDER.indexOf(x) !== -1; });
      if (lv.length) m.effort = EFFORT_ORDER.filter(function (x) { return lv.indexOf(x) !== -1; });
    }
    if (typeof raw.effortDefault === "string" && EFFORT_ORDER.indexOf(raw.effortDefault) !== -1) {
      m.effortDefault = raw.effortDefault;
    }
    // Unset here = the provider's (see normaliseProvider). `context1m: true`
    // is the spelling of the first release, kept as "both".
    if (CONTEXT_MODES.indexOf(raw.context) !== -1) m.context = raw.context;
    else if (raw.context1m === true) m.context = "both";
    // Its sub-agent type: on unless `agent: false`; an object customises the
    // name, the description and the prompt (agentDefs fills the rest). The
    // name is resolved in readConfig, where uniqueness can be checked.
    m.agent = raw.agent !== false;
    if (isObj(raw.agent)) {
      if (typeof raw.agent.name === "string" && raw.agent.name.trim()) m.agentWanted = raw.agent.name.trim().toLowerCase();
      if (typeof raw.agent.description === "string" && raw.agent.description.trim()) m.agentDescription = raw.agent.description.trim();
      if (typeof raw.agent.prompt === "string" && raw.agent.prompt.trim()) m.agentPrompt = raw.agent.prompt.trim();
    }
    return m;
  }
  // The ids a model is listed under, per its context mode - what the picker
  // shows, what the page persists, what the CLI receives as --model.
  function listedIds(m) {
    if (m.context === "1m") return [m.alias + "[1m]"];
    if (m.context === "both") return [m.alias, m.alias + "[1m]"];
    return [m.alias];
  }
  // The id a sub-agent (or the sub-agent default) runs the model under: the
  // 1M twin when the model is listed with one - an agent's job is the long one.
  function agentModelId(m) {
    var ids = listedIds(m);
    return ids[ids.length - 1];
  }
  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  }

  function normaliseProvider(raw, idx, locked, secrets) {
    if (!isObj(raw)) { warnOnce("prov" + idx, "providers[" + idx + "] is not an object - skipped"); return null; }
    var id = typeof raw.id === "string" && PROVIDER_ID_RE.test(raw.id.trim()) ? raw.id.trim() : "";
    if (!id) { warnOnce("provid" + idx, "providers[" + idx + "] needs an id (letters, digits, - _), skipped"); return null; }
    var baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) {
      warnOnce("url" + idx, "provider " + id + ": baseUrl must be an http(s) URL - skipped");
      return null;
    }
    var k = resolveKey(Object.assign({}, raw, { id: id }), idx, secrets);
    var p = { id: id, baseUrl: baseUrl, apiKey: k.key, keySource: k.source, locked: locked, models: [] };
    if (typeof raw.preset === "string" && presetOf(raw.preset)) p.preset = raw.preset;
    // The effort values the provider's API accepts under the app's names -
    // an API convention, so it lives on the provider; a model may still
    // override it in the file. Absent: the preset's knowledge, else all five.
    var levels = null;
    if (Array.isArray(raw.effort)) {
      levels = EFFORT_ORDER.filter(function (l) { return raw.effort.indexOf(l) !== -1; });
      if (!levels.length) levels = null;
    }
    if (!levels && p.preset && presetOf(p.preset) && presetOf(p.preset).effort) levels = presetOf(p.preset).effort.slice();
    p.effort = levels || EFFORT_ORDER.slice();
    // The context window its models are exposed with (CONTEXT_MODES): the
    // file's value, else the preset's knowledge, else 200k - the CLI's own
    // assumption for a model it does not know.
    if (CONTEXT_MODES.indexOf(raw.context) !== -1) p.context = raw.context;
    else if (p.preset && presetOf(p.preset) && presetOf(p.preset).context) p.context = presetOf(p.preset).context;
    else p.context = DEFAULT_CONTEXT;
    if (typeof raw.modelsUrl === "string" && /^https?:\/\/[^\s]+$/.test(raw.modelsUrl.trim())) p.modelsUrl = raw.modelsUrl.trim();
    if (isObj(raw.headers)) p.headers = raw.headers;
    if (isObj(raw.effortMap)) p.effortMap = raw.effortMap;
    if (typeof raw.webSearch === "string" && raw.webSearch.trim()) p.webSearch = raw.webSearch.trim();
    (Array.isArray(raw.models) ? raw.models : []).forEach(function (m, i) {
      var n = normaliseModel(m, id, i);
      if (!n) return;
      if (!n.effort) n.effort = p.effort.slice();
      if (!n.context) n.context = p.context;
      p.models.push(n);
    });
    return p;
  }

  function readSources() {
    return {
      jsonc: readFileJson(pathFor(JSONC_NAME)) || {},
      json: readFileJson(pathFor(JSON_NAME)) || {}
    };
  }

  function readConfig() {
    var src = readSources();
    var a = isObj(src.jsonc[PREF_KEY]) ? src.jsonc[PREF_KEY] : {};
    var b = isObj(src.json[PREF_KEY]) ? src.json[PREF_KEY] : {};
    var secrets = readSecrets();

    var providers = [];
    var byId = Object.create(null);
    var seenModel = Object.create(null);
    function take(list, locked) {
      (Array.isArray(list) ? list : []).forEach(function (raw, idx) {
        var p = normaliseProvider(raw, idx, locked, secrets);
        if (!p) return;
        if (byId[p.id]) { warnOnce("dupprov" + p.id, "provider " + p.id + " is in both files - the .jsonc one wins"); return; }
        p.models = p.models.filter(function (m) {
          if (seenModel[m.alias]) { warnOnce("dup" + m.alias, "model id " + m.id + " listed twice - keeping the first"); return false; }
          seenModel[m.alias] = m;
          return true;
        });
        byId[p.id] = p;
        providers.push(p);
      });
    }
    take(a.providers, true);
    take(b.providers, false);
    var usable = providers.filter(function (p) { return p.models.length > 0; });

    var surfRaw = Array.isArray(a.surfaces) ? a.surfaces : (Array.isArray(b.surfaces) ? b.surfaces : null);
    var surfaces = surfRaw
      ? surfRaw.filter(function (s) { return typeof s === "string" && SURFACE_RE.test(s); })
      : DEFAULT_SURFACES;
    if (!surfaces.length) surfaces = DEFAULT_SURFACES;

    var enabled, source;
    if (typeof a.enabled === "boolean") { enabled = a.enabled; source = "jsonc-locked"; }
    else if (typeof b.enabled === "boolean") { enabled = b.enabled; source = "json"; }
    else { enabled = usable.length > 0; source = "default"; }

    // Web search is one app-wide choice (the CLI sends one sub-request per
    // search, whatever the session's model): the .jsonc value, else the
    // .json one, else - for configs written before it was global - the first
    // provider that names one. Resolved to the alias of a configured model.
    var wsRaw = typeof a.webSearch === "string" ? a.webSearch
      : (typeof b.webSearch === "string" ? b.webSearch : "");
    var wsLocked = typeof a.webSearch === "string";
    if (!wsRaw) usable.some(function (p) { if (p.webSearch) { wsRaw = p.webSearch; return true; } return false; });
    var webSearch = "";
    if (wsRaw.trim()) {
      var want = wsRaw.trim();
      var alias = want.indexOf(ID_PREFIX) === 0 ? want : ID_PREFIX + want;
      if (seenModel[alias]) {
        if (seenModel[alias].webSearch) webSearch = alias;
        else warnOnce("wsno" + want, "webSearch names " + want + ", which is marked without the web search tool - web search stays on Anthropic");
      } else if (ANTHROPIC_ID_RE.test(want)) webSearch = want;
      else warnOnce("ws" + want, "webSearch names " + want + ", which is neither a configured model nor an Anthropic id - web search stays on Anthropic");
    }

    // Sub-agent type names, one per model that has one: the configured name
    // when valid, else the display name slugged; never a built-in's, never
    // twice - the provider id, then a counter, break a tie.
    var usedNames = Object.create(null);
    usable.forEach(function (p) {
      p.models.forEach(function (m) {
        if (!m.agent) return;
        var want = m.agentWanted || "";
        if (want && !AGENT_NAME_RE.test(want)) {
          warnOnce("agname" + m.alias, "model " + m.id + ": agent.name \"" + want + "\" is not lowercase letters, digits and - (max 40) - name generated instead");
          want = "";
        }
        if (!want) want = slug(m.name) || slug(m.id) || "custom-model";
        if (RESERVED_AGENT_NAMES.indexOf(want) !== -1) want = slug(want + "-" + p.id);
        var name = want;
        if (usedNames[name]) name = slug(want + "-" + p.id);
        for (var n = 2; usedNames[name]; n++) name = slug(want + "-" + n);
        usedNames[name] = true;
        m.agentName = name;
      });
    });

    // The default sub-agent model (CLAUDE_CODE_SUBAGENT_MODEL): what a
    // sub-agent whose definition names no model runs on - the CLI's own
    // general-purpose and Plan included; not Explore, which the CLI pins to
    // "inherit" (the session's model), and not a type with a model of its own
    // (checked in the CLI 2.1.266: CLAUDE_CODE_SUBAGENT_MODEL_FORCE would
    // override those too, ours included - not offered). "" = the CLI's own
    // default, the session's model. Resolved to the listed id.
    var samRaw = typeof a.subagentModel === "string" ? a.subagentModel
      : (typeof b.subagentModel === "string" ? b.subagentModel : "");
    var samLocked = typeof a.subagentModel === "string";
    var subagentModel = "";
    if (samRaw.trim()) {
      var samWant = samRaw.trim().replace(/\[1m\]$/, "");
      var samAlias = samWant.indexOf(ID_PREFIX) === 0 ? samWant : ID_PREFIX + samWant;
      if (seenModel[samAlias]) subagentModel = agentModelId(seenModel[samAlias]);
      else warnOnce("sam" + samWant, "subagentModel names " + samWant + ", which is not a configured model - sub-agents keep the CLI's default");
    }
    // Whether every new session's system prompt gets the one line that tells
    // Claude these models and sub-agent types exist (announceText).
    var announce = typeof a.announce === "boolean" ? a.announce
      : (typeof b.announce === "boolean" ? b.announce : true);
    var announceLocked = typeof a.announce === "boolean";

    return { enabled: enabled, source: source, surfaces: surfaces, providers: usable,
      allProviders: providers, configured: usable.length > 0,
      webSearch: webSearch, webSearchLocked: wsLocked,
      subagentModel: subagentModel, subagentModelLocked: samLocked,
      announce: announce, announceLocked: announceLocked };
  }
  function activeConfig() {
    var c = readConfig();
    return c.enabled && c.configured ? c : null;
  }

  // Writes ONLY the .json, tmp + rename, every other key survives. A broken
  // existing file refuses instead of being overwritten (see panel_tabs_main.js
  // for the reasoning; same contract here). `mutate(customModels)` edits the
  // key in place and returns nothing.
  function writeJson(mutate) {
    var p = pathFor(JSON_NAME);
    if (!p) return { ok: false, error: "no userData path" };
    var raw = null;
    try { raw = _fs.readFileSync(p, "utf8"); }
    catch (e) {
      if (e.code !== "ENOENT") return { ok: false, error: "cannot read " + p + ": " + ((e && e.message) || String(e)) };
    }
    var cfg = {};
    if (raw !== null) {
      var stripped = stripComments(raw);
      try { cfg = stripped.trim() ? JSON.parse(stripped) : {}; }
      catch (e2) {
        return { ok: false, error: p + " is not valid JSON (" + e2.message + ") - fix or remove it first; nothing was written" };
      }
      if (!isObj(cfg)) return { ok: false, error: p + " must contain a JSON object; nothing was written" };
      if (stripped !== raw) {
        try { _fs.writeFileSync(p + ".cdb-bak", raw, { flag: "wx" }); } catch (e3) {}
      }
    }
    var cur = isObj(cfg[PREF_KEY]) ? cfg[PREF_KEY] : {};
    mutate(cur);
    if (Object.keys(cur).length) cfg[PREF_KEY] = cur; else delete cfg[PREF_KEY];
    var tmp = p + ".cdb-tmp";
    try {
      _fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      _fs.renameSync(tmp, p);
    } catch (e4) {
      try { _fs.unlinkSync(tmp); } catch (e5) {}
      return { ok: false, error: "cannot write " + p + ": " + ((e4 && e4.message) || String(e4)) };
    }
    syncRoutes();
    return { ok: true, path: p };
  }
  function writePref(value) {
    return writeJson(function (cur) { cur.enabled = value; });
  }

  // ---- picker entries -------------------------------------------------------
  // The shape is the one the live bootstrap carries for the desktop Code
  // surface (`ccd`), observed 2026-09-13 - see baseline/CUSTOM_MODELS_ANCHORS.md:
  //   { id, name, short_name, section: "main"|"overflow"|"deprecated",
  //     capabilities: {compass, gsuite_tools, mm_images, mm_pdf, web_search},
  //     thinking: { type: "effort", description, effort_options: [{id, name,
  //       badge?, tooltip?}] } | { type: "effort_and_mode", ..., mode_options }
  //       | { type: "none" },
  //     quick_select?: true, notice?, fast_mode?, min_claude_code_version? }
  // Labels are LOCALISED server-side ("Élevé", "Par défaut"), so instead of
  // shipping English strings the effort menu is copied from the first
  // Anthropic entry of the same surface that has one, filtered to the levels
  // the model offers; the English table below is only the fallback for a
  // surface with no such entry.
  var EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  var EFFORT_NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" };
  var EFFORT_DESC = "Higher effort means more thorough responses, but takes longer and uses your limits faster.";
  var DEFAULT_BADGE = { message: "Default", variant: "neutral" };
  var MODE_OPTIONS = [
    { id: "auto", name: "Thinking", description: "Can think for more complex tasks" },
    { id: "off", name: "Off" }
  ];

  // The surface's own effort menu, to borrow labels from: the first entry
  // whose thinking carries effort_options.
  function effortTemplate(surface) {
    var models = Array.isArray(surface.models) ? surface.models : [];
    for (var i = 0; i < models.length; i++) {
      var t = models[i] && models[i].thinking;
      if (isObj(t) && Array.isArray(t.effort_options) && t.effort_options.length) return t;
    }
    return null;
  }

  // The level the picker preselects: the configured one if it is offered,
  // else xhigh when offered (the app's own default for its top models), else
  // the highest level offered.
  function effortDefaultOf(m) {
    if (!m.thinking) return "";
    var levels = m.effort || EFFORT_ORDER;
    if (m.effortDefault && levels.indexOf(m.effortDefault) !== -1) return m.effortDefault;
    return levels.indexOf("xhigh") !== -1 ? "xhigh" : levels[levels.length - 1];
  }
  function thinkingSpec(m, template) {
    if (!m.thinking) return { type: "none" };
    var levels = m.effort || EFFORT_ORDER;
    var rec = effortDefaultOf(m);
    var byId = Object.create(null);
    var badge = null;
    if (template) {
      template.effort_options.forEach(function (o) {
        if (!isObj(o) || typeof o.id !== "string") return;
        byId[o.id] = o;
        if (isObj(o.badge) && !badge) badge = o.badge;
      });
    }
    var effort = levels.map(function (id) {
      var src = byId[id];
      var o = { id: id, name: src && typeof src.name === "string" ? src.name : EFFORT_NAMES[id] };
      if (src && isObj(src.tooltip)) o.tooltip = JSON.parse(JSON.stringify(src.tooltip));
      if (id === rec) { o.recommended = true; o.badge = JSON.parse(JSON.stringify(badge || DEFAULT_BADGE)); }
      return o;
    });
    var out = { type: "effort", description: template && typeof template.description === "string" ? template.description : EFFORT_DESC,
      effort_options: effort };
    if (template && Array.isArray(template.mode_options) && template.mode_options.length) {
      out.type = "effort_and_mode";
      out.mode_options = JSON.parse(JSON.stringify(template.mode_options));
    } else if (template && template.type === "effort_and_mode") {
      out.type = "effort_and_mode";
      out.mode_options = MODE_OPTIONS.map(function (o) { return Object.assign({}, o); });
    }
    return out;
  }

  function pickerEntries(m, surface) {
    var base = {
      id: m.alias,
      name: m.name,
      short_name: m.shortName || m.name,
      description: m.description,
      section: m.section,
      capabilities: { compass: true, gsuite_tools: true, mm_images: m.vision, mm_pdf: false, web_search: m.webSearch },
      thinking: thinkingSpec(m, effortTemplate(surface))
    };
    if (m.section === "main") base.quick_select = true;
    if (m.badge) base.badge = { message: m.badge, variant: "neutral" };
    // "1m": the [1m] spelling is the only one listed, under the plain name -
    // no supports_1m_context, which is what makes the page append " 1M".
    if (m.context === "1m") return [Object.assign({}, base, { id: m.alias + "[1m]" })];
    if (m.context !== "both") return [base];
    return [base, Object.assign({}, base, { id: m.alias + "[1m]", description: "1M context window", supports_1m_context: true })];
  }

  // Pure: returns the enriched bootstrap, or null when there is nothing to do
  // (no config, no model_selector_config, every entry already present).
  // `choices` (optional) is the selection store: {<state id>: {model, thinking}}.
  function enrichBootstrap(boot, cfg, choices) {
    if (!isObj(boot) || !Array.isArray(boot.model_selector_config)) return null;
    if (!cfg || !cfg.providers.length) return null;
    var changed = false;
    var aliases = listedAliases(cfg);
    boot.model_selector_config.forEach(function (surface) {
      if (!isObj(surface) || cfg.surfaces.indexOf(surface.id) === -1) return;
      if (!Array.isArray(surface.models)) surface.models = [];
      var have = Object.create(null);
      surface.models.forEach(function (e) { if (isObj(e) && typeof e.id === "string") have[e.id] = true; });
      cfg.providers.forEach(function (p) {
        p.models.forEach(function (m) {
          pickerEntries(m, surface).forEach(function (e) {
            if (have[e.id]) return;
            surface.models.push(e);
            have[e.id] = true;
            changed = true;
          });
        });
      });
    });
    // The remembered choice: what the server would carry for an Anthropic
    // model, applied to the state of the surfaces the page writes to.
    if (choices && Array.isArray(boot.model_selector_state)) {
      boot.model_selector_state.forEach(function (st) {
        if (!isObj(st) || typeof st.id !== "string") return;
        var c = choices[st.id];
        if (!c || !aliases[c.model]) return;
        if (st.model !== c.model) { st.model = c.model; changed = true; }
        var th = isObj(c.thinking) ? c.thinking : defaultThinkingState(aliases[c.model]);
        if (th) {
          st.thinking = JSON.parse(JSON.stringify(th));
          if (!Array.isArray(st.thinking_by_model)) st.thinking_by_model = [];
          var found = false;
          st.thinking_by_model.forEach(function (e) {
            if (isObj(e) && e.id === c.model) { e.thinking = JSON.parse(JSON.stringify(th)); found = true; }
          });
          if (!found) st.thinking_by_model.push({ id: c.model, thinking: JSON.parse(JSON.stringify(th)) });
          changed = true;
        }
      });
    }
    return changed ? boot : null;
  }
  function defaultThinkingState(m) {
    if (!m || !m.thinking) return null;
    return { type: "effort", effort: effortDefaultOf(m) };
  }

  // ---- remembered selection --------------------------------------------------
  // The page persists the picked model server-side: PATCH /api/organizations/
  // <org>/model_selector_state/<surface> with {model, thinking...}, answered
  // with the surface's state ({id, model, thinking_by_model:[...]}) and
  // returned in every bootstrap. claude.ai refuses an id it does not know
  // (400 model_not_selectable), so a custom model would be forgotten the
  // moment the session ends. The store below is that server state, kept in
  // the profile for our models only: a refused PATCH for one of ours is
  // answered locally in the server's own shape and remembered, and the next
  // bootstrap carries the choice back exactly as it would for Opus. A PATCH
  // the server accepts (an Anthropic model was picked) drops the memory for
  // that surface, so the server's state wins again.
  var STATE_NAME = "selection.json";
  function statePath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, STATE_NAME) : null;
  }
  function readChoices() {
    var v = readFileJson(statePath());
    var out = Object.create(null);
    if (v) Object.keys(v).forEach(function (k) {
      if (isObj(v[k]) && typeof v[k].model === "string") out[k] = v[k];
    });
    return out;
  }
  function writeChoices(map) {
    var p = statePath();
    if (!p) return;
    try {
      _fs.mkdirSync(_path.dirname(p), { recursive: true, mode: 448 });
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
    } catch (e) { log("cannot write " + p + ": " + (e && e.message ? e.message : String(e))); }
  }
  // The last state the server sent for each surface, to answer a refused
  // PATCH with a complete object (thinking_by_model for every other model).
  var lastServerState = Object.create(null);
  // The Anthropic models the bootstrap listed for the first configured
  // surface, so the panel can offer them as web-search targets by name.
  var lastAnthropicModels = [];
  function rememberServerState(boot, cfg) {
    if (!isObj(boot)) return;
    if (Array.isArray(boot.model_selector_state)) {
      boot.model_selector_state.forEach(function (st) {
        if (isObj(st) && typeof st.id === "string") lastServerState[st.id] = JSON.parse(JSON.stringify(st));
      });
    }
    if (Array.isArray(boot.model_selector_config)) {
      var want = cfg && cfg.surfaces ? cfg.surfaces[0] : DEFAULT_SURFACES[0];
      boot.model_selector_config.forEach(function (sf) {
        if (!isObj(sf) || sf.id !== want || !Array.isArray(sf.models)) return;
        var ours = Object.create(null);
        (cfg ? cfg.providers : []).forEach(function (p) { p.models.forEach(function (m) { ours[m.alias] = true; ours[m.alias + "[1m]"] = true; }); });
        lastAnthropicModels = sf.models.filter(function (m) {
          return isObj(m) && typeof m.id === "string" && ANTHROPIC_ID_RE.test(m.id) && !ours[m.id] &&
            !(isObj(m.capabilities) && m.capabilities.web_search === false) && m.section !== "deprecated";
        }).map(function (m) { return { id: m.id, name: typeof m.name === "string" ? m.name : m.id }; });
      });
    }
  }
  function surfaceOf(url) {
    var m = /\/model_selector_state\/([a-z0-9_]+)(?:[?#]|$)/.exec(String(url));
    return m ? m[1] : null;
  }
  // Pure: given the surface, the page's request body, the response status
  // and the configured aliases, decide what to store and what to answer.
  // Returns { choices: <new store or null when unchanged>, reply: <body or null> }.
  function selectionOutcome(surface, method, reqBody, status, cfg, choices) {
    if (method !== "PATCH" || !surface) return { choices: null, reply: null };
    var aliases = listedAliases(cfg);
    var req = null;
    try { req = JSON.parse(reqBody || ""); } catch (e) {}
    if (!isObj(req)) return { choices: null, reply: null };
    var carriesModel = typeof req.model === "string";
    var ours = carriesModel && !!aliases[req.model];
    var next = Object.assign(Object.create(null), choices);
    var remembered = next[surface] && aliases[next[surface].model] ? next[surface] : null;
    if (status >= 200 && status < 300) {
      // The server took it. A model it knows (an Anthropic one was picked):
      // its state is authoritative again. A write without a model - the
      // page adjusting the thinking or fast mode of the CURRENT model - is
      // applied by the server to the model it holds (Opus), not to ours:
      // the memory stays, updated with the thinking the page asked for, and
      // the page gets our state back instead of the server's.
      if (carriesModel) {
        if (remembered) { delete next[surface]; return { choices: next, reply: null }; }
        return { choices: null, reply: null };
      }
      if (!remembered) return { choices: null, reply: null };
      if (isObj(req.thinking)) remembered.thinking = req.thinking;
      return { choices: next, reply: stateReply(surface, remembered.model, remembered.thinking) };
    }
    if (!ours || status < 400) return { choices: null, reply: null };
    var thinking = isObj(req.thinking) ? req.thinking : defaultThinkingState(aliases[req.model]);
    next[surface] = { model: req.model, thinking: thinking };
    return { choices: next, reply: stateReply(surface, req.model, thinking) };
  }
  // Every id a configured model is listed under -> the model.
  function listedAliases(cfg) {
    var aliases = Object.create(null);
    cfg.providers.forEach(function (p) { p.models.forEach(function (m) {
      listedIds(m).forEach(function (id) { aliases[id] = m; });
    }); });
    return aliases;
  }
  // The server's own answer shape for a surface, built on the last state it
  // sent (thinking_by_model for every other model) with our model on top.
  function stateReply(surface, model, thinking) {
    var base = lastServerState[surface] ? JSON.parse(JSON.stringify(lastServerState[surface])) : { id: surface };
    var reply = { id: surface, model: model, thinking_by_model: Array.isArray(base.thinking_by_model) ? base.thinking_by_model : [] };
    if (thinking) {
      reply.thinking = JSON.parse(JSON.stringify(thinking));
      var found = false;
      reply.thinking_by_model.forEach(function (e) { if (isObj(e) && e.id === model) { e.thinking = thinking; found = true; } });
      if (!found) reply.thinking_by_model.push({ id: model, thinking: thinking });
    }
    return reply;
  }
  function onSelectionPaused(wc, params) {
    var dbg = wc.debugger;
    var id = params.requestId;
    function release() { dbg.sendCommand("Fetch.continueRequest", { requestId: id }).catch(function () {}); }
    var cfg = activeConfig();
    if (!cfg) { release(); return; }
    var surface = surfaceOf(params.request.url);
    var out = selectionOutcome(surface, params.request.method, params.request.postData, params.responseStatusCode, cfg, readChoices());
    if (out.choices) writeChoices(out.choices);
    if (!out.reply) { release(); return; }
    var body = Buffer.from(JSON.stringify(out.reply), "utf8").toString("base64");
    dbg.sendCommand("Fetch.fulfillRequest", {
      requestId: id, responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: body
    }).then(function () {
      log("selection: " + out.reply.model + " kept locally for surface " + surface + (params.responseStatusCode >= 400
        ? " (claude.ai does not know that id, HTTP " + params.responseStatusCode + " - expected)" : " (thinking updated)"));
    }, function (e) {
      log("selection: " + (e && e.message ? e.message : String(e)));
      release();
    });
  }

  // ---- bootstrap interception (CDP Fetch domain) ----------------------------
  // The page's own scripts run before dom-ready, so an executeJavaScript
  // fetch hook would arrive after the bootstrap request has left. The Fetch
  // domain pauses the RESPONSE in the network stack instead, whatever the
  // timing, and only for the URL patterns below - every other request is
  // untouched. DevTools can be open at the same time (Chromium multiplexes
  // clients). Every paused request MUST be released (fulfill or continue) or
  // the page hangs on it, hence the fail-open shape of onPaused.
  // The page fetches /edge-api/bootstrap/<org>/app_start (observed) or the
  // /api/ spelling of the same endpoint (the app's own 3p stub list names
  // both), and re-fetches it on its own schedule; each response is enriched.
  var PATTERNS = [];
  ["claude.ai", "*.claude.ai", "claude.com", "*.claude.com"].forEach(function (h) {
    ["/api/bootstrap", "/edge-api/bootstrap"].forEach(function (base) {
      // The bare endpoint (with or without a query) and the per-org app_start;
      // the other /bootstrap/<org>/* sub-resources are not paused at all.
      PATTERNS.push("*://" + h + base, "*://" + h + base + "?*", "*://" + h + base + "/*/app_start*");
    });
    PATTERNS.push("*://" + h + "/api/organizations/*/model_selector_state/*");
  });
  function hostOk(rawUrl) {
    var host;
    try { host = new _URL(String(rawUrl)).hostname; } catch (e) { return false; }
    return host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "claude.com" || host.endsWith(".claude.com");
  }
  function dropHopHeaders(headers) {
    return (Array.isArray(headers) ? headers : []).filter(function (h) {
      var n = String(h && h.name || "").toLowerCase();
      return n !== "content-length" && n !== "content-encoding" && n !== "transfer-encoding";
    });
  }

  function onPaused(wc, params) {
    var dbg = wc.debugger;
    var id = params.requestId;
    function release() { dbg.sendCommand("Fetch.continueRequest", { requestId: id }).catch(function () {}); }
    if (params.responseErrorReason || typeof params.responseStatusCode !== "number") { release(); return; }
    if (/\/model_selector_state\//.test(params.request.url)) { onSelectionPaused(wc, params); return; }
    if (params.responseStatusCode !== 200) { release(); return; }
    var cfg = activeConfig();
    if (!cfg) { release(); return; }
    dbg.sendCommand("Fetch.getResponseBody", { requestId: id }).then(function (res) {
      var text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
      var boot;
      try { boot = JSON.parse(text); } catch (e) { release(); return; }
      if (DEBUG) {
        try {
          log("debug: bootstrap surfaces " + (boot.model_selector_config || []).map(function (sf) {
            return sf.id + "[" + (sf.models || []).map(function (m) { return m.id; }).join("|") + "]";
          }).join(" "));
        } catch (e) {}
      }
      rememberServerState(boot, cfg);
      var out = enrichBootstrap(boot, cfg, readChoices());
      if (!out) { release(); return; }
      var body = Buffer.from(JSON.stringify(out), "utf8").toString("base64");
      return dbg.sendCommand("Fetch.fulfillRequest", {
        requestId: id,
        responseCode: params.responseStatusCode,
        responseHeaders: dropHopHeaders(params.responseHeaders),
        body: body
      }).then(function () {
        var n = 0;
        cfg.providers.forEach(function (p) { n += p.models.length; });
        log("bootstrap enriched: " + n + " custom model(s) on " + cfg.surfaces.join(",") + " (" + params.request.url + ")");
      });
    }).catch(function (e) {
      log("bootstrap: " + (e && e.message ? e.message : String(e)) + " - passing the response through");
      release();
    });
  }

  function safeUrl(wc) {
    try { return wc.getURL() || "(no url yet)"; } catch (e) { return "(no url)"; }
  }
  function attach(wc) {
    if (wc.__cdbCmAttached) return;
    var dbg = wc.debugger;
    if (!dbg) return;
    try { dbg.attach("1.3"); }
    catch (e) { log("debugger attach failed: " + (e && e.message ? e.message : String(e))); return; }
    wc.__cdbCmAttached = true;
    dbg.on("message", function (_ev, method, params) {
      if (method === "Fetch.requestPaused") {
        try { onPaused(wc, params); }
        catch (e) { dbg.sendCommand("Fetch.continueRequest", { requestId: params.requestId }).catch(function () {}); }
      } else if (DEBUG && method === "Network.requestWillBeSent") {
        // CDB_CUSTOM_MODELS_DEBUG=1: every API request the page makes, path
        // only, so a moved bootstrap endpoint can be found again from the log.
        try {
          var u = new _URL(params.request.url);
          if (/^\/(edge-)?api\//.test(u.pathname)) log("debug: page " + params.request.method + " " + u.pathname);
        } catch (e) {}
      }
    });
    if (DEBUG) dbg.sendCommand("Network.enable").catch(function () {});
    dbg.on("detach", function (_ev, reason) {
      wc.__cdbCmAttached = false;
      log("debugger detached (" + reason + ") - re-attaching on the next navigation");
    });
    dbg.sendCommand("Fetch.enable", {
      patterns: PATTERNS.map(function (u) { return { urlPattern: u, requestStage: "Response" }; })
    }).then(function () {
      log("watching /api/bootstrap responses on " + safeUrl(wc));
    }, function (e) {
      log("Fetch.enable failed: " + (e && e.message ? e.message : String(e)));
    });
  }

  _app.on("web-contents-created", function (_ev, wc) {
    // Only claude.ai/claude.com main frames; attach BEFORE the navigation
    // commits so the first bootstrap fetch is already covered.
    wc.on("did-start-navigation", function (details, url, isInPlace, isMainFrame) {
      try {
        var d = details && typeof details === "object" && "url" in details ? details : null;
        var u = d ? d.url : url;
        var main = d ? d.isMainFrame !== false : isMainFrame !== false;
        if (!main || !hostOk(u)) return;
        if (!readConfig().configured) return;
        attach(wc);
      } catch (e) {}
    });
  });

  // ---- CLI environment ------------------------------------------------------
  // Called at every local Code session spawn (sub-patch B). Writes the preload
  // under userData (profile-isolated) when its content changed, and returns
  // the env to splice in, or {} when the feature is off - in which case the
  // session is exactly upstream's.
  function ensurePreload() {
    var dir = pathFor(SUBDIR);
    if (!dir) return null;
    var p = _path.join(dir, PRELOAD_NAME);
    try {
      _fs.mkdirSync(dir, { recursive: true, mode: 448 });
      var cur = null;
      try { cur = _fs.readFileSync(p, "utf8"); } catch (e) {}
      if (cur !== PRELOAD_SRC) {
        var tmp = p + ".cdb-tmp";
        _fs.writeFileSync(tmp, PRELOAD_SRC, { encoding: "utf8", mode: 420 });
        _fs.renameSync(tmp, p);
      }
      return p;
    } catch (e) {
      log("cannot write " + p + ": " + (e && e.message ? e.message : String(e)));
      return null;
    }
  }
  // The routing payload the preload works from: providers with their keys,
  // models with what the sanitiser needs, the app-wide web-search target.
  function routesPayload(cfg) {
    if (!cfg) return { providers: [] };
    var payload = { providers: cfg.providers.map(function (p) {
      var o = { id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey,
        models: p.models.map(function (m) {
          return { id: m.id, vision: m.vision, thinking: m.thinking, webSearch: m.webSearch };
        }) };
      if (p.headers) o.headers = p.headers;
      if (p.effortMap) o.effortMap = p.effortMap;
      return o;
    }) };
    if (cfg.webSearch) payload.webSearch = cfg.webSearch;
    return payload;
  }
  function routesPath() {
    var d = pathFor(SUBDIR);
    return d ? _path.join(d, ROUTES_NAME) : null;
  }
  // Rewrites routes.json from the current configuration - the sessions
  // already open re-read it on their next request, so a key fixed, a model
  // added or a provider removed takes effect without a restart. Off (or
  // nothing configured) writes an empty list, which stops the routing in
  // those sessions the same way. Only written when the content changed.
  var lastRoutesText = null;
  function syncRoutes() {
    var p = routesPath();
    if (!p) return;
    try {
      var text = JSON.stringify(routesPayload(activeConfig()), null, 2) + "\n";
      if (text === lastRoutesText) return;
      _fs.mkdirSync(_path.dirname(p), { recursive: true, mode: 448 });
      var tmp = p + ".cdb-tmp";
      _fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 384 });
      _fs.renameSync(tmp, p);
      lastRoutesText = text;
    } catch (e) { log("cannot write " + p + ": " + (e && e.message ? e.message : String(e))); }
  }
  function cliEnv() {
    try {
      var cfg = activeConfig();
      if (DEBUG) log("debug: cliEnv() called, active=" + !!cfg);
      if (!cfg) return {};
      var preload = ensurePreload();
      if (!preload) return {};
      syncRoutes();
      var logDir = pathFor("logs");
      var prior = typeof process.env.BUN_OPTIONS === "string" ? process.env.BUN_OPTIONS.trim() : "";
      var opt = "--preload=" + preload;
      // The initial routes travel in the environment (works even if the file
      // cannot be read); the file is what keeps them current afterwards.
      var env = {
        BUN_OPTIONS: prior && prior.indexOf(opt) === -1 ? prior + " " + opt : (prior || opt),
        CDB_CUSTOM_MODELS_JSON: JSON.stringify(routesPayload(cfg))
      };
      var rp = routesPath();
      if (rp) env.CDB_CUSTOM_MODELS_ROUTES = rp;
      if (logDir) env.CDB_CUSTOM_MODELS_LOG = _path.join(logDir, LOG_NAME);
      if (DEBUG) env.CDB_CUSTOM_MODELS_DEBUG = "1"; // the preload then logs the passthroughs too
      // The CLI's own switch for the model of every sub-agent that names none
      // - honoured with our ids the same way (checked 2026-09-14, CLI 2.1.266).
      if (cfg.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = cfg.subagentModel;
      return env;
    } catch (e) {
      log("cliEnv: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return {};
    }
  }

  // ---- sub-agent types and the system-prompt line ---------------------------
  // The app hands the CLI, in the `initialize` request that opens every
  // session, the same two fields the Agent SDK exposes: `agents` (programmatic
  // sub-agent definitions - what a ~/.claude/agents/<name>.md file declares,
  // without the file) and `appendSystemPrompt`. Sub-patch C of the Nim patch
  // routes both through here. A definition's `model` takes any id the CLI
  // accepts on --model, so one type per custom model gives
  // `Agent(subagent_type: <name>)` and a workflow's `agentType` on that model;
  // the Agent tool's own `model` parameter stays an enum of Anthropic tiers -
  // it cannot name ours, which is why the line below says so. Both are read
  // when the session starts: a model added later reaches the next session.
  function agentDescription(p, m) {
    return "Sub-agent running on " + m.name + " via " + p.id + ", a custom model outside Anthropic's. Use it when " +
      "a task should run on that model: give it a self-contained brief and the output format you expect.";
  }
  function agentPrompt(p, m) {
    return "You are a sub-agent running on " + m.name + ", a custom model served by " + p.id + ". Work only from " +
      "what your prompt provides; when something is missing, say so instead of guessing. Your final message is " +
      "returned to the orchestrator as data: follow the requested output format exactly, with nothing outside it.";
  }
  function agentDefs(cfg) {
    var out = {};
    cfg.providers.forEach(function (p) {
      p.models.forEach(function (m) {
        if (!m.agent || !m.agentName) return;
        out[m.agentName] = {
          description: m.agentDescription || agentDescription(p, m),
          prompt: m.agentPrompt || agentPrompt(p, m),
          model: agentModelId(m)
        };
      });
    });
    return out;
  }
  // `theirs` is whatever the app put in initConfig.agents (nothing, as of
  // 2026-09-14). The app's own definitions win a name clash; a shape we do
  // not expect is left alone.
  function agents(theirs) {
    try {
      var cfg = activeConfig();
      if (!cfg) return theirs;
      var ours = agentDefs(cfg);
      if (!Object.keys(ours).length) return theirs;
      if (theirs === undefined || theirs === null) return ours;
      if (!isObj(theirs)) return theirs;
      return Object.assign({}, ours, theirs);
    } catch (e) {
      log("agents: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return theirs;
    }
  }
  function announceText(cfg) {
    var entries = [], types = [];
    cfg.providers.forEach(function (p) {
      p.models.forEach(function (m) {
        entries.push(listedIds(m).join(" and ") + " (" + m.name + ", " + p.id +
          (m.agent && m.agentName ? "; sub-agent type " + m.agentName : "") + ")");
        if (m.agent && m.agentName) types.push(m.agentName);
      });
    });
    var text = "Custom models available in this app (claude-desktop-extra), served by the user's own providers: " +
      entries.join("; ") + ". To run work on one of them" +
      (types.length ? ", launch its sub-agent type with the Agent tool (subagent_type), or in a workflow script " +
        "use agent(prompt, {agentType: \"<type>\"}) or agent(prompt, {model: \"<id>\"})"
        : ", in a workflow script use agent(prompt, {model: \"<id>\"})") +
      ". These ids are not valid values for the Agent tool's `model` parameter, which only accepts Anthropic tiers.";
    if (cfg.subagentModel) text += " Sub-agents launched without a model of their own run on " + cfg.subagentModel + ".";
    return text;
  }
  function appendSystemPrompt(theirs) {
    try {
      var cfg = activeConfig();
      if (!cfg || !cfg.announce) return theirs;
      var text = announceText(cfg);
      if (typeof theirs === "string") return theirs.trim() ? theirs + "\n\n" + text : text;
      if (Array.isArray(theirs)) return theirs.concat([text]);
      return text;
    } catch (e) {
      log("appendSystemPrompt: " + (e && e.message ? e.message : String(e)) + " - session left untouched");
      return theirs;
    }
  }

  // ---- IPC (Settings -> Extra) ----------------------------------------------
  var ALLOWED_ORIGINS = [
    "https://claude.ai", "https://preview.claude.ai",
    "https://claude.com", "https://preview.claude.com"
  ];
  function originAllowed(rawUrl) {
    var origin;
    try { origin = new _URL(String(rawUrl)).origin; } catch (e) { return false; }
    return ALLOWED_ORIGINS.indexOf(origin) !== -1;
  }
  // FAILS CLOSED, same as the panel-tabs precedent: a sender without
  // isDestroyed() throws into the catch and is rejected.
  function okSender(ev) {
    try {
      var wc = ev && ev.sender;
      if (!wc || wc.isDestroyed()) return false;
      if (!originAllowed(wc.getURL() || "")) return false;
      var frame = ev.senderFrame;
      if (frame && frame.parent) return false;
      return true;
    } catch (e) { return false; }
  }
  function summary(cfg) {
    var models = 0;
    var providers = cfg.providers.map(function (p) {
      models += p.models.length;
      return { id: p.id, models: p.models.length, keyOk: p.apiKey.length > 8 };
    });
    return { ok: true, enabled: cfg.enabled === true && cfg.configured, configured: cfg.configured,
      lockedByJsonc: cfg.source === "jsonc-locked", source: cfg.source,
      surfaces: cfg.surfaces, models: models, providers: providers };
  }
  // The panel's view of the configuration: every provider (usable or not),
  // never a key value - only where the key comes from and whether it is there.
  function detail(cfg) {
    var out = summary(cfg);
    out.providers = cfg.allProviders.map(function (p) {
      return {
        id: p.id, baseUrl: p.baseUrl, locked: p.locked, preset: p.preset || "", modelsUrl: p.modelsUrl || "",
        keyOk: p.apiKey.length > 8, keySource: p.keySource, effort: p.effort.slice(), context: p.context,
        models: p.models.map(function (m) {
          return { id: m.id, alias: m.alias, listedAs: listedIds(m), name: m.name, description: m.description,
            vision: m.vision, thinking: m.thinking, webSearch: m.webSearch, context: m.context || p.context,
            effort: m.effort || EFFORT_ORDER.slice(), effortDefault: effortDefaultOf(m), badge: m.badge,
            // Its sub-agent type as it will be handed to the CLI, and what
            // the form shows as placeholders when nothing is customised.
            agent: m.agent, agentName: m.agent ? m.agentName || "" : "",
            agentDescription: m.agentDescription || "", agentPrompt: m.agentPrompt || "",
            agentDefaults: { name: m.agentName || slug(m.name) || slug(m.id), description: agentDescription(p, m), prompt: agentPrompt(p, m) } };
        })
      };
    });
    out.webSearch = cfg.webSearch;
    out.webSearchLocked = cfg.webSearchLocked;
    out.subagentModel = cfg.subagentModel;
    out.subagentModelLocked = cfg.subagentModelLocked;
    out.announce = cfg.announce;
    out.announceLocked = cfg.announceLocked;
    out.announceText = cfg.enabled && cfg.configured && cfg.announce ? announceText(cfg) : "";
    out.anthropicModels = lastAnthropicModels.slice();
    out.paths = { json: pathFor(JSON_NAME), jsonc: pathFor(JSONC_NAME), secrets: secretsPath(), routes: routesPath() };
    out.presets = PRESETS;
    return out;
  }

  // What the "Add a provider" form offers to prefill - the endpoints known to
  // speak the Anthropic Messages API. A preset is a suggestion, every field
  // stays editable.
  var PRESETS = [
    // Static knowledge only: where the Anthropic-compatible endpoint is,
    // where the provider lists its models (OpenAI-shaped GET /v1/models,
    // Authorization: Bearer), the effort values it is known to accept and,
    // when every model it serves has it, the context window (CONTEXT_MODES).
    // Model ids are NOT listed here - they age in months; "fetch models" on
    // the card asks the provider. Endpoints as documented for Claude Code
    // (ANTHROPIC_BASE_URL) by the vendors, 2026-09; DeepSeek's verified.
    // DeepSeek: 1M context on every model, one price whatever the length.
    { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic",
      modelsUrl: "https://api.deepseek.com/v1/models", keyHint: "sk-... from platform.deepseek.com",
      effort: ["low", "high", "max"], context: "1m" },
    { id: "kimi", label: "Kimi (Moonshot, international)", baseUrl: "https://api.moonshot.ai/anthropic",
      modelsUrl: "https://api.moonshot.ai/v1/models", keyHint: "sk-... from platform.moonshot.ai" },
    { id: "glm", label: "GLM (Z.ai, international)", baseUrl: "https://api.z.ai/api/anthropic",
      keyHint: "from z.ai" },
    { id: "glm-cn", label: "GLM (Zhipu, China)", baseUrl: "https://open.bigmodel.cn/api/anthropic",
      keyHint: "from open.bigmodel.cn" },
    { id: "minimax", label: "MiniMax (international)", baseUrl: "https://api.minimax.io/anthropic",
      keyHint: "from platform.minimax.io" },
    { id: "qwen", label: "Qwen (DashScope)", baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
      modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models", keyHint: "sk-... from DashScope" },
    // OpenRouter: one key, hundreds of models (Qwen, GLM, DeepSeek, Kimi, the
    // Claude models...), Anthropic-compatible /v1/messages, public /v1/models
    // that carries each model's context length.
    { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api",
      modelsUrl: "https://openrouter.ai/api/v1/models", keyHint: "sk-or-... from openrouter.ai/keys" },
    { id: "gateway", label: "Anthropic-compatible gateway (LiteLLM...)", baseUrl: "",
      keyHint: "the gateway's key" }
  ];
  function presetOf(id) {
    var out = null;
    PRESETS.forEach(function (pr) { if (pr.id === id) out = pr; });
    return out;
  }

  function cleanString(v, max) {
    return typeof v === "string" ? v.trim().slice(0, max || 200) : "";
  }
  // The provider fields the panel may write. The key is handled apart (it goes
  // to the secrets file); everything else lands in the .json entry.
  function providerPatch(input) {
    if (!isObj(input)) return { error: "provider must be an object" };
    var id = cleanString(input.id, 40);
    if (!PROVIDER_ID_RE.test(id)) return { error: "provider id: letters, digits, - and _ only" };
    var baseUrl = cleanString(input.baseUrl, 300).replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return { error: "base URL must start with http:// or https://" };
    var out = { id: id, baseUrl: baseUrl };
    var preset = cleanString(input.preset, 40);
    if (preset && presetOf(preset)) out.preset = preset;
    var modelsUrl = cleanString(input.modelsUrl, 300);
    if (modelsUrl) {
      if (!/^https?:\/\/[^\s]+$/.test(modelsUrl)) return { error: "models URL must start with http:// or https://" };
      out.modelsUrl = modelsUrl;
    }
    if (Array.isArray(input.effort)) {
      var picked = EFFORT_ORDER.filter(function (l) { return input.effort.indexOf(l) !== -1; });
      if (!picked.length) return { error: "offer at least one effort level" };
      out.effort = picked;
    }
    if (CONTEXT_MODES.indexOf(input.context) !== -1) out.context = input.context;
    return { value: out };
  }
  // `levelsOf` / `contextOf`: the provider's, which the model inherits - only
  // a different value is written.
  function modelPatch(input, levelsOf, contextOf) {
    if (!isObj(input)) return { error: "model must be an object" };
    var id = cleanString(input.id, 120);
    if (!ID_RE.test(id)) return { error: "model id: letters, digits, . _ : / and - only" };
    var out = { id: id };
    var name = cleanString(input.name, 60);
    if (name && name !== id) out.name = name;
    var description = cleanString(input.description, 120);
    if (description) out.description = description;
    var badge = cleanString(input.badge, 24);
    if (badge) out.badge = badge;
    if (input.vision === false) out.vision = false;
    if (input.thinking === false) out.thinking = false;
    if (input.webSearch === false) out.webSearch = false;
    var inherited = CONTEXT_MODES.indexOf(contextOf) !== -1 ? contextOf : DEFAULT_CONTEXT;
    var context = CONTEXT_MODES.indexOf(input.context) !== -1 ? input.context : (input.context1m === true ? "both" : "");
    if (context && context !== inherited) out.context = context;
    // The levels come from the provider (levelsOf); the default is written
    // only when it differs from what the picker would preselect anyway.
    var levels = Array.isArray(levelsOf) && levelsOf.length ? levelsOf : EFFORT_ORDER.slice();
    var auto = levels.indexOf("xhigh") !== -1 ? "xhigh" : levels[levels.length - 1];
    if (typeof input.effortDefault === "string" && levels.indexOf(input.effortDefault) !== -1 &&
        input.effortDefault !== auto) out.effortDefault = input.effortDefault;
    // The sub-agent type: off is written as `agent: false`; on writes only
    // what differs from the generated name, description and prompt.
    if (input.agent === false) out.agent = false;
    else {
      var ag = {};
      var agName = cleanString(input.agentName, 40).toLowerCase();
      if (agName) {
        if (!AGENT_NAME_RE.test(agName)) return { error: "sub-agent name: lowercase letters, digits and - only (40 max)" };
        if (RESERVED_AGENT_NAMES.indexOf(agName) !== -1) return { error: "sub-agent name " + agName + " is one of Claude Code's built-in types" };
        ag.name = agName;
      }
      var agDesc = cleanString(input.agentDescription, 600);
      if (agDesc) ag.description = agDesc;
      var agPrompt = cleanString(input.agentPrompt, 6000);
      if (agPrompt) ag.prompt = agPrompt;
      if (Object.keys(ag).length) out.agent = ag;
    }
    return { value: out };
  }
  function findJsonProvider(cur, id) {
    if (!Array.isArray(cur.providers)) cur.providers = [];
    for (var i = 0; i < cur.providers.length; i++) {
      if (isObj(cur.providers[i]) && cur.providers[i].id === id) return i;
    }
    return -1;
  }
  function lockedProvider(cfg, id) {
    return cfg.allProviders.some(function (p) { return p.id === id && p.locked; });
  }

  _ipc.handle("cdb-cm:pref-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    return summary(readConfig());
  });

  _ipc.handle("cdb-cm:pref-set", function (ev, enabled) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    var cfg = readConfig();
    if (cfg.source === "jsonc-locked") {
      return { ok: false, error: PREF_KEY + ".enabled is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    if (enabled && !cfg.configured) {
      return { ok: false, error: "no custom model is configured - add a provider and a model in Settings > Extra > Models first" };
    }
    var w = writePref(enabled);
    if (!w.ok) return w;
    return Object.assign(summary(readConfig()), { path: w.path });
  });

  _ipc.handle("cdb-cm:config-read", function (ev) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    return detail(readConfig());
  });

  // Upsert a provider (id, baseUrl) in the .json; a non-empty apiKey goes to
  // the secrets file and the entry is marked apiKeyStored.
  _ipc.handle("cdb-cm:provider-set", function (ev, input) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    var pp = providerPatch(input);
    if (pp.error) return { ok: false, error: pp.error };
    var cfg = readConfig();
    if (lockedProvider(cfg, pp.value.id)) {
      return { ok: false, error: "provider " + pp.value.id + " is set in " + JSONC_NAME + " - edit that file to change it" };
    }
    var key = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (key) {
      if (key.length < 8 || key.length > 512 || /\s/.test(key)) return { ok: false, error: "that does not look like an API key" };
      var secrets = readSecrets();
      secrets[pp.value.id] = key;
      var ws = writeSecrets(secrets);
      if (!ws.ok) return ws;
    }
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, pp.value.id);
      var prev = i === -1 ? {} : cur.providers[i];
      var next = Object.assign({}, prev, pp.value);
      var preset = pp.value.preset || prev.preset;
      // The preset is endpoint knowledge attached at creation: an edit that
      // does not name one keeps it. The models URL is a plain field: empty
      // clears it.
      if (!pp.value.modelsUrl) delete next.modelsUrl;
      if (pp.value.effort && pp.value.effort.length === EFFORT_ORDER.length && !(preset && presetOf(preset) && presetOf(preset).effort)) delete next.effort;
      if (key) next.apiKeyStored = true;
      if (!Array.isArray(next.models)) next.models = [];
      if (i === -1) cur.providers.push(next); else cur.providers[i] = next;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  _ipc.handle("cdb-cm:provider-delete", function (ev, id) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    id = cleanString(id, 40);
    if (!PROVIDER_ID_RE.test(id)) return { ok: false, error: "bad provider id" };
    var cfg = readConfig();
    if (lockedProvider(cfg, id)) return { ok: false, error: "provider " + id + " is set in " + JSONC_NAME + " - edit that file to remove it" };
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, id);
      if (i !== -1) cur.providers.splice(i, 1);
      if (!cur.providers.length) delete cur.providers;
    });
    if (!w.ok) return w;
    var secrets = readSecrets();
    if (secrets[id] !== undefined) { delete secrets[id]; writeSecrets(secrets); }
    return detail(readConfig());
  });

  _ipc.handle("cdb-cm:model-set", function (ev, providerId, input) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var owner = null;
    cfg.allProviders.forEach(function (p) { if (p.id === providerId) owner = p; });
    var mp = modelPatch(input, owner ? owner.effort : null, owner ? owner.context : null);
    if (mp.error) return { ok: false, error: mp.error };
    if (lockedProvider(cfg, providerId)) return { ok: false, error: "provider " + providerId + " is set in " + JSONC_NAME + " - edit that file to change it" };
    var alias = mp.value.id.indexOf(ID_PREFIX) === 0 ? mp.value.id : ID_PREFIX + mp.value.id;
    var clash = cfg.allProviders.some(function (p) {
      return p.id !== providerId && p.models.some(function (m) { return m.alias === alias; });
    });
    if (clash) return { ok: false, error: "model id " + mp.value.id + " is already used by another provider" };
    var known = cfg.allProviders.some(function (p) { return p.id === providerId && !p.locked; });
    if (!known) return { ok: false, error: "provider " + providerId + " is not in " + JSON_NAME + " - add it first" };
    // A typed sub-agent name must be free: a generated one steps aside on
    // its own, a typed one would silently lose to the other model's.
    if (mp.value.agent && mp.value.agent.name) {
      var taken = null;
      cfg.providers.forEach(function (p) {
        p.models.forEach(function (m) {
          if (m.agent && m.agentName === mp.value.agent.name && !(p.id === providerId && m.id === mp.value.id)) taken = p.id + " / " + m.id;
        });
      });
      if (taken) return { ok: false, error: "sub-agent name " + mp.value.agent.name + " is already used by " + taken };
    }
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, providerId);
      if (i === -1) return;
      var prov = cur.providers[i];
      if (!Array.isArray(prov.models)) prov.models = [];
      var j = -1;
      prov.models.forEach(function (m, k) { if (isObj(m) && m.id === mp.value.id) j = k; });
      if (j === -1) prov.models.push(mp.value); else prov.models[j] = mp.value;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  _ipc.handle("cdb-cm:model-delete", function (ev, providerId, modelId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    modelId = cleanString(modelId, 120);
    var cfg = readConfig();
    if (lockedProvider(cfg, providerId)) return { ok: false, error: "provider " + providerId + " is set in " + JSONC_NAME + " - edit that file to change it" };
    var w = writeJson(function (cur) {
      var i = findJsonProvider(cur, providerId);
      if (i === -1) return;
      var prov = cur.providers[i];
      if (!Array.isArray(prov.models)) return;
      prov.models = prov.models.filter(function (m) { return !(isObj(m) && m.id === modelId); });
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The app-wide web-search choice: "" for Anthropic's default, else the id
  // (or alias) of a configured custom model.
  _ipc.handle("cdb-cm:websearch-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    value = cleanString(value, 130);
    var cfg = readConfig();
    if (cfg.webSearchLocked) return { ok: false, error: "webSearch is set in " + JSONC_NAME + " - edit that file to change it" };
    if (value) {
      var alias = value.indexOf(ID_PREFIX) === 0 ? value : ID_PREFIX + value;
      var mine = null;
      cfg.providers.forEach(function (p) { p.models.forEach(function (m) { if (m.alias === alias) mine = m; }); });
      if (mine) {
        if (!mine.webSearch) return { ok: false, error: mine.id + " is marked without the web search tool" };
        value = alias;
      } else if (ANTHROPIC_ID_RE.test(value)) {
        // an Anthropic model: kept as typed, checked against the last bootstrap when we have one
        if (lastAnthropicModels.length && !lastAnthropicModels.some(function (m) { return m.id === value; })) {
          return { ok: false, error: value + " is not one of the Anthropic models the picker lists" };
        }
      } else return { ok: false, error: value + " is neither a configured model nor an Anthropic model id" };
    }
    var w = writeJson(function (cur) {
      if (value) cur.webSearch = value; else delete cur.webSearch;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The default sub-agent model: "" for the CLI's own default (the session's
  // model), else the id (or alias) of a configured custom model.
  _ipc.handle("cdb-cm:subagent-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    value = cleanString(value, 130);
    var cfg = readConfig();
    if (cfg.subagentModelLocked) return { ok: false, error: "subagentModel is set in " + JSONC_NAME + " - edit that file to change it" };
    if (value) {
      var want = value.replace(/\[1m\]$/, "");
      var alias = want.indexOf(ID_PREFIX) === 0 ? want : ID_PREFIX + want;
      var mine = null;
      cfg.providers.forEach(function (p) { p.models.forEach(function (m) { if (m.alias === alias) mine = m; }); });
      if (!mine) return { ok: false, error: value + " is not a configured custom model" };
      value = alias;
    }
    var w = writeJson(function (cur) {
      if (value) cur.subagentModel = value; else delete cur.subagentModel;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // Whether new sessions get the system-prompt line (announceText).
  _ipc.handle("cdb-cm:announce-set", function (ev, value) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    if (typeof value !== "boolean") return { ok: false, error: "announce must be a boolean" };
    var cfg = readConfig();
    if (cfg.announceLocked) return { ok: false, error: "announce is set in " + JSONC_NAME + " - edit that file to change it" };
    var w = writeJson(function (cur) {
      if (value) delete cur.announce; else cur.announce = false;
    });
    if (!w.ok) return w;
    return detail(readConfig());
  });

  // The provider's own model list. Tried in order: the provider's modelsUrl
  // (preset or typed), then the Anthropic shape at <baseUrl>/v1/models, then
  // the OpenAI shape at <origin>/v1/models and <origin>/models. Both shapes
  // answer {data:[{id, display_name?}]}; the key goes as x-api-key AND
  // Authorization: Bearer, whichever the endpoint reads.
  // Returns { models, nextAfter } - nextAfter is the cursor of the Anthropic
  // Models API shape ({data, has_more, last_id}, 20 per page, ?after_id=),
  // null when the answer is complete.
  function parseModelList(text) {
    var j;
    try { j = JSON.parse(text); } catch (e) { return null; }
    var arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : (j && Array.isArray(j.models) ? j.models : null));
    if (!arr) return null;
    var nextAfter = j && !Array.isArray(j) && j.has_more === true && typeof j.last_id === "string" && j.last_id ? j.last_id : null;
    var out = [];
    arr.forEach(function (m) {
      var id = isObj(m) ? (typeof m.id === "string" ? m.id : (typeof m.name === "string" ? m.name : "")) : (typeof m === "string" ? m : "");
      if (!id || !ID_RE.test(id)) return;
      // display_name (Anthropic shape) or name (OpenRouter: "Qwen: Qwen3.8 Max")
      var name = id;
      if (isObj(m)) {
        if (typeof m.display_name === "string" && m.display_name.trim()) name = m.display_name.trim();
        else if (typeof m.name === "string" && m.name.trim() && m.name !== id) name = m.name.trim();
      }
      var e = { id: id, name: name };
      // A listing that states the context length (OpenRouter's does) settles
      // the model's context mode: 1M when it serves at least that.
      var cl = isObj(m) ? (typeof m.context_length === "number" ? m.context_length : (typeof m.context_window === "number" ? m.context_window : null)) : null;
      if (cl !== null) e.context = cl >= 1000000 ? "1m" : "200k";
      out.push(e);
    });
    return { models: out, nextAfter: nextAfter };
  }
  _ipc.handle("cdb-cm:models-list", function (ev, providerId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    var origin;
    try { origin = new _URL(p.baseUrl).origin; } catch (e) { origin = null; }
    var candidates = [];
    var pr = p.preset ? presetOf(p.preset) : null;
    if (p.modelsUrl) candidates.push(p.modelsUrl);
    if (pr && pr.modelsUrl) candidates.push(pr.modelsUrl);
    candidates.push(p.baseUrl + "/v1/models");
    if (origin) candidates.push(origin + "/v1/models", origin + "/models");
    var seen = Object.create(null);
    candidates = candidates.filter(function (u) { if (seen[u]) return false; seen[u] = true; return true; });
    // Two header sets, in this order: the OpenAI/OpenRouter shape (Bearer,
    // the whole catalogue with context lengths) and, only when that is
    // refused, the Anthropic Models API (anthropic-version - OpenRouter then
    // answers in that shape: 20 per page, ids prefixed, no context length).
    // Anthropic's own endpoint and gateways proxying it need the second.
    var base = { "accept": "application/json", "x-api-key": p.apiKey, "authorization": "Bearer " + p.apiKey };
    if (p.headers) Object.keys(p.headers).forEach(function (k) { if (typeof p.headers[k] === "string") base[k] = p.headers[k]; });
    var headerSets = [base, Object.assign({}, base, { "anthropic-version": "2023-06-01" })];
    var failures = [];
    var MAX_PAGES = 40;
    function getJson(url, headers) {
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 15000);
      return fetch(url, { method: "GET", headers: headers, signal: ctl.signal }).then(function (res) {
        return res.text().then(function (text) { clearTimeout(timer); return { status: res.status, ok: res.ok, text: text }; });
      }, function (e) {
        clearTimeout(timer);
        return { status: 0, ok: false, text: "", error: e && e.name === "AbortError" ? "no answer within 15 s" : (e && e.message ? e.message : String(e)) };
      });
    }
    // Follows has_more/last_id with ?after_id= until the list is complete.
    function pages(url, headers, acc, after, n) {
      var u = after ? url + (url.indexOf("?") === -1 ? "?" : "&") + "after_id=" + encodeURIComponent(after) : url;
      return getJson(u, headers).then(function (r) {
        if (!r.ok) return { fail: u + " -> " + (r.error || "HTTP " + r.status), models: acc };
        var page = parseModelList(r.text);
        if (!page) return { fail: u + " -> no model list in the answer", models: acc };
        var all = acc.concat(page.models);
        if (page.nextAfter && n < MAX_PAGES) return pages(url, headers, all, page.nextAfter, n + 1);
        return { models: all };
      });
    }
    function tryNext(i, h) {
      if (i >= candidates.length) {
        return { ok: false, error: "no model list found - tried " + candidates.join(", ") +
          (failures.length ? " (" + failures.join("; ") + ")" : "") + ". Add the models by hand." };
      }
      var url = candidates[i];
      return pages(url, headerSets[h], [], null, 0).then(function (r) {
        if (r.fail && !r.models.length) {
          failures.push(r.fail);
          return h + 1 < headerSets.length ? tryNext(i, h + 1) : tryNext(i + 1, 0);
        }
        if (!r.models.length) { failures.push(url + " -> empty list"); return h + 1 < headerSets.length ? tryNext(i, h + 1) : tryNext(i + 1, 0); }
        // Duplicates across pages (a gateway's alias rows) are dropped.
        var seenId = Object.create(null);
        var models = r.models.filter(function (m) { if (seenId[m.id]) return false; seenId[m.id] = true; return true; });
        return { ok: true, source: url, models: models, partial: r.fail || null };
      });
    }
    return tryNext(0, 0);
  });

  // Which of the app's five effort levels a provider accepts for a model:
  // one token with each value, in parallel. What we cannot know from here,
  // the provider's own answer settles. Five minimum-size requests.
  _ipc.handle("cdb-cm:effort-probe", function (ev, providerId, modelId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    modelId = cleanString(modelId, 120);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    if (!modelId && p.models.length) modelId = p.models[0].id;
    if (!ID_RE.test(modelId)) return { ok: false, error: "add a model first - the probe sends one token to it with each level" };
    var headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": p.apiKey };
    if (p.headers) Object.keys(p.headers).forEach(function (k) { if (typeof p.headers[k] === "string") headers[k] = p.headers[k]; });
    return Promise.all(EFFORT_ORDER.map(function (level) {
      var body = { model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }],
        thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: level } };
      var ctl = new AbortController();
      var timer = setTimeout(function () { ctl.abort(); }, 20000);
      return fetch(p.baseUrl + "/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body), signal: ctl.signal })
        .then(function (res) {
          return res.text().then(function (text) {
            clearTimeout(timer);
            if (res.ok) return { level: level, ok: true };
            var msg = text.slice(0, 200);
            try { var j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
            return { level: level, ok: false, status: res.status, error: msg };
          });
        }, function (e) {
          clearTimeout(timer);
          return { level: level, ok: false, error: e && e.name === "AbortError" ? "no answer within 20 s" : (e && e.message ? e.message : String(e)) };
        });
    })).then(function (results) {
      var accepted = results.filter(function (r) { return r.ok; }).map(function (r) { return r.level; });
      var rejected = {};
      results.forEach(function (r) { if (!r.ok) rejected[r.level] = (r.status ? "HTTP " + r.status + ": " : "") + r.error; });
      // Every level refused for the same reason is not an effort problem
      // (bad key, wrong URL, unknown model): say so instead of "none".
      if (!accepted.length) {
        var msgs = Object.keys(rejected).map(function (k) { return rejected[k]; });
        var same = msgs.every(function (m) { return m === msgs[0]; });
        return { ok: false, error: same ? msgs[0] : "every level was refused: " + JSON.stringify(rejected) };
      }
      return { ok: true, accepted: accepted, rejected: rejected };
    });
  });

  // A one-token round trip to the provider with the stored key, so a typo in
  // the URL or the key shows here and not as a failed session. Costs the
  // provider's minimum billable request.
  _ipc.handle("cdb-cm:provider-test", function (ev, providerId) {
    if (!okSender(ev)) return { ok: false, error: "rejected: unrecognized sender" };
    providerId = cleanString(providerId, 40);
    var cfg = readConfig();
    var p = null;
    cfg.allProviders.forEach(function (x) { if (x.id === providerId) p = x; });
    if (!p) return { ok: false, error: "unknown provider " + providerId };
    if (!p.apiKey) return { ok: false, error: "no API key for provider " + providerId };
    if (!p.models.length) return { ok: false, error: "add a model first - the test sends one token to it" };
    var model = p.models[0];
    var body = { model: model.id, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
    var headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": p.apiKey };
    if (p.headers) Object.keys(p.headers).forEach(function (k) { if (typeof p.headers[k] === "string") headers[k] = p.headers[k]; });
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 20000);
    return fetch(p.baseUrl + "/v1/messages", { method: "POST", headers: headers, body: JSON.stringify(body), signal: ctl.signal })
      .then(function (res) {
        return res.text().then(function (text) {
          clearTimeout(timer);
          if (res.ok) return { ok: true, status: res.status, model: model.id };
          var msg = text.slice(0, 300);
          try { var j = JSON.parse(text); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) {}
          return { ok: false, status: res.status, error: "HTTP " + res.status + ": " + msg };
        });
      }, function (e) {
        clearTimeout(timer);
        return { ok: false, error: e && e.name === "AbortError" ? "no answer within 20 s" : (e && e.message ? e.message : String(e)) };
      });
  });

  globalThis.__cdbCustomModels = { cliEnv: cliEnv, enrichBootstrap: enrichBootstrap, readConfig: readConfig,
    selectionOutcome: selectionOutcome, rememberServerState: rememberServerState, listedIds: listedIds, syncRoutes: syncRoutes,
    agents: agents, appendSystemPrompt: appendSystemPrompt };

  // The files edited by hand (the .jsonc, a key file's secrets.json) are not
  // written through the panel: watch them so routes.json follows those
  // edits too. One directory watch each, debounced; a watch that cannot be
  // set (unusual filesystem) only costs the live update for hand edits.
  function watchForRoutes() {
    var dirs = [pathFor(""), pathFor(SUBDIR)];
    var names = { "claude-desktop-extra.jsonc": true, "claude-desktop-extra.json": true, "secrets.json": true };
    var timer = null;
    dirs.forEach(function (d) {
      if (!d) return;
      try {
        _fs.mkdirSync(d, { recursive: true });
        var w = _fs.watch(d, { persistent: false }, function (_ev, name) {
          if (!name || !names[String(name)]) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () { timer = null; syncRoutes(); }, 300);
        });
        w.on("error", function () {});
      } catch (e) { log("cannot watch " + d + " for hand edits (" + (e && e.message ? e.message : String(e)) + ")"); }
    });
  }

  setTimeout(function () {
    var c = readConfig();
    var n = 0, types = [];
    c.providers.forEach(function (p) { n += p.models.length; p.models.forEach(function (m) { if (m.agent && m.agentName) types.push(m.agentName); }); });
    if (c.configured || _fs.existsSync(routesPath() || "")) syncRoutes();
    watchForRoutes();
    log("installed (main); " + (c.configured ? n + " model(s) from " + c.providers.length + " provider(s), " +
      (c.enabled ? "on" : "off") + " (source: " + c.source + "), surfaces " + c.surfaces.join(",") +
      (types.length ? ", sub-agent types " + types.join(",") : ", no sub-agent type") +
      (c.subagentModel ? ", sub-agent default " + c.subagentModel : "") + (c.announce ? "" : ", system-prompt line off")
      : "no customModels.providers configured - feature idle"));
  }, 0);
})();
