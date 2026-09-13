/*
 * custom_models_preload.js - the Claude Code CLI half of the custom models
 * feature. NOT Electron code: this file runs INSIDE the Claude Code binary
 * (a compiled Bun program) as a Bun preload, before the CLI's own code.
 *
 * How it gets there: js/custom_models_main.js writes this file under
 * <userData>/custom-models/preload.js and adds BUN_OPTIONS=--preload=<that
 * path> plus CDB_CUSTOM_MODELS_JSON=<resolved config> to the environment of
 * every local Code session it spawns (patches/community/add_feature_custom_models.nim
 * sub-patch B). Bun honours BUN_OPTIONS for compiled binaries; NODE_OPTIONS
 * and bunfig.toml are not read by them.
 *
 * What it does: replaces globalThis.fetch in the CLI process. A POST to
 * /v1/messages whose `model` is one of the configured ids (exposed to the CLI
 * as "claude-<id>", because the CLI's set_model validator only accepts ids
 * matching ^claude-\S+$) is rewritten to the provider's Anthropic-compatible
 * endpoint with the provider's own key. Everything else - Claude models, OAuth,
 * telemetry, count_tokens for Claude models - passes through untouched.
 *
 * Fail-open: any error in the hook falls back to the original fetch and logs
 * one line to CDB_CUSTOM_MODELS_LOG. The two env vars are DELETED from
 * process.env as soon as they are read so that nothing the CLI spawns (the
 * Bash tool's shells, MCP servers, `bun` itself) inherits the provider key or
 * the preload.
 */
"use strict";
(function () {
  var SELFTEST = process.env.CDB_CUSTOM_MODELS_SELFTEST === "1";
  var path = require("node:path");
  var fs = require("node:fs");

  // Read-and-scrub: the key must not outlive this function in the environment.
  var rawJson = process.env.CDB_CUSTOM_MODELS_JSON;
  var logPath = process.env.CDB_CUSTOM_MODELS_LOG || "";
  var bunOptions = process.env.BUN_OPTIONS;
  delete process.env.CDB_CUSTOM_MODELS_JSON;
  delete process.env.CDB_CUSTOM_MODELS_LOG;
  if (typeof bunOptions === "string") {
    // Strip only our own --preload token; a user's other BUN_OPTIONS survive.
    var kept = bunOptions.split(/\s+/).filter(function (t) {
      return t && !/^--preload=.*custom-models[\\/]preload\.js$/.test(t);
    }).join(" ");
    if (kept) process.env.BUN_OPTIONS = kept; else delete process.env.BUN_OPTIONS;
  }

  function log(msg) {
    if (!logPath) return;
    try {
      var st = fs.statSync(logPath, { throwIfNoEntry: false });
      if (st && st.size > 1000000) fs.truncateSync(logPath, 0);
      fs.appendFileSync(logPath, new Date().toISOString() + " [" + process.pid + "] " + msg + "\n");
    } catch (e) {}
  }

  if (!SELFTEST) {
    if (typeof Bun === "undefined") return;
    if (path.basename(process.execPath) !== "claude") return;
  }
  if (!rawJson) return;

  var cfg;
  try { cfg = JSON.parse(rawJson); }
  catch (e) { log("config unreadable (" + e.message + ") - routing off"); return; }

  // The CLI validator's pass: anything ^claude-\S+$ is accepted by set_model.
  var PREFIX = "claude-";
  function exposedId(id) { return id.indexOf(PREFIX) === 0 ? id : PREFIX + id; }

  // alias (what the CLI sends) -> { provider, model }
  var routes = new Map();
  var providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  providers.forEach(function (p) {
    if (!p || typeof p !== "object" || !Array.isArray(p.models)) return;
    p.models.forEach(function (m) {
      if (!m || typeof m.id !== "string" || !m.id.trim()) return;
      var alias = exposedId(m.id.trim());
      if (!routes.has(alias)) routes.set(alias, { provider: p, model: m });
    });
  });
  if (!routes.size) { log("no custom model configured - routing off"); return; }

  function providerBase(p) {
    return String(p.baseUrl || "").replace(/\/+$/, "");
  }
  function providerKeyOk(p) {
    var k = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
    return k.length > 8;
  }
  // The CLI's web-search sub-request (one server tool, normally answered by a
  // small Claude model) can be handed to one of the custom models instead:
  // provider.webSearch = "<model id>". Only the first provider that asks wins.
  var webSearchRoute = null;
  providers.some(function (p) {
    if (!p || typeof p.webSearch !== "string") return false;
    var r = routes.get(exposedId(p.webSearch.trim()));
    if (r && r.provider === p) { webSearchRoute = r; return true; }
    return false;
  });

  // ---- request sanitising -------------------------------------------------
  // The target is an Anthropic-COMPATIBLE endpoint, not Anthropic: only the
  // documented subset of the Messages API is forwarded. Anything the CLI adds
  // for Anthropic proper (beta headers, cache_control, context_management,
  // metadata, mcp_servers, redacted/signed thinking) is dropped or normalised.
  function textBlock(text) { return { type: "text", text: text }; }

  function cleanBlock(b, m, stripThinking) {
    if (typeof b === "string") return [textBlock(b)];
    if (!b || typeof b !== "object") return [];
    switch (b.type) {
      case "text":
        return typeof b.text === "string" && b.text.length ? [textBlock(b.text)] : [];
      case "image":
        if (m.vision !== false) return [{ type: "image", source: b.source }];
        return [textBlock("[image omitted: " + m.id + " has no vision]")];
      case "tool_use":
        return [{ type: "tool_use", id: b.id, name: b.name, input: b.input == null ? {} : b.input }];
      case "tool_result": {
        var out = { type: "tool_result", tool_use_id: b.tool_use_id };
        if (b.is_error) out.is_error = true;
        if (typeof b.content === "string") out.content = b.content;
        else if (Array.isArray(b.content)) {
          var c = [];
          b.content.forEach(function (x) { c.push.apply(c, cleanBlock(x, m, stripThinking)); });
          out.content = c.length ? c : "";
        }
        return [out];
      }
      case "thinking":
        return stripThinking ? [] : [b];
      case "redacted_thinking":
        return [];
      case "document": {
        var src = b.source || {};
        if (src.type === "text" && typeof src.data === "string") return [textBlock(src.data)];
        return [textBlock("[document omitted: " + (b.title || src.media_type || "unsupported") + "]")];
      }
      case "server_tool_use":
      case "web_search_tool_result":
        return [b]; // native web search, same block shapes as Anthropic
      default:
        return []; // search_result, code_execution_*, mcp_*, ...
    }
  }

  function cleanMessages(messages, m, stripThinking) {
    if (!Array.isArray(messages)) return [];
    var out = [];
    messages.forEach(function (msg) {
      if (!msg || typeof msg !== "object") return;
      var content = msg.content;
      if (typeof content === "string") content = [textBlock(content)];
      else if (Array.isArray(content)) {
        var flat = [];
        content.forEach(function (b) { flat.push.apply(flat, cleanBlock(b, m, stripThinking)); });
        content = flat;
      } else content = [];
      // Mid-conversation system messages (the CLI's mid-conversation-system
      // beta: /effort changes and friends) are folded into user text -
      // compatible endpoints only take user/assistant.
      var role = msg.role === "assistant" ? "assistant" : "user";
      if (msg.role === "system") {
        content = content.map(function (b) { return b.type === "text" ? textBlock("[system] " + b.text) : b; });
      }
      if (!content.length) content = [textBlock("(untransferable content omitted)")];
      var prev = out[out.length - 1];
      if (prev && prev.role === role) prev.content.push.apply(prev.content, content); // strict alternation
      else out.push({ role: role, content: content });
    });
    return out;
  }

  // App effort (low..max) -> provider effort. DeepSeek only knows low/high/max
  // and every published benchmark ran at max, so xhigh - the app's default for
  // its top models - lands on max. Overridable per provider with effortMap.
  var EFFORT_DEFAULT = { low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };

  function sanitize(body, route, opts) {
    var m = route.model, p = route.provider;
    var out = { model: m.id };
    ["max_tokens", "stream", "temperature", "top_p", "stop_sequences"].forEach(function (k) {
      if (body[k] !== undefined) out[k] = body[k];
    });
    if (typeof body.system === "string") out.system = body.system;
    else if (Array.isArray(body.system)) {
      var sys = body.system.filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
        .map(function (b) { return textBlock(b.text); });
      if (sys.length) out.system = sys;
    }
    out.messages = cleanMessages(body.messages, m, opts.stripThinking);
    if (Array.isArray(body.tools)) {
      var tools = body.tools.filter(function (t) {
        return t && typeof t.name === "string" &&
          ((t.input_schema && typeof t.input_schema === "object") || /^web_search/.test(t.type || ""));
      }).map(function (t) {
        return /^web_search/.test(t.type || "")
          ? { type: t.type, name: t.name }
          : { name: t.name, description: typeof t.description === "string" ? t.description : "", input_schema: t.input_schema };
      });
      if (tools.length) {
        out.tools = tools;
        var tc = body.tool_choice;
        if (tc && typeof tc === "object" && typeof tc.type === "string") {
          out.tool_choice = tc.type === "tool" && tc.name ? { type: "tool", name: tc.name } : { type: tc.type };
        }
      }
    }
    // Thinking: the model may forbid it (thinking:false); otherwise the app's
    // choice (mode "off" arrives as thinking.type === "disabled") is honoured
    // and the budget is clamped to what compatible endpoints accept.
    var requestedOff = body.thinking && typeof body.thinking === "object" && body.thinking.type === "disabled";
    var think = m.thinking !== false && !requestedOff;
    if (think) {
      var max = typeof out.max_tokens === "number" ? out.max_tokens : 32000;
      out.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(16000, max - 1)) };
    } else {
      out.thinking = { type: "disabled" };
    }
    // Effort only ever travels with thinking on - DeepSeek answers 400 to
    // "reasoning_effort with thinking disabled".
    var effortMap = p.effortMap && typeof p.effortMap === "object" ? p.effortMap : EFFORT_DEFAULT;
    var sent = body.output_config && typeof body.output_config.effort === "string" ? effortMap[body.output_config.effort] : undefined;
    var effort = m.effort !== undefined ? m.effort : sent;
    if (think && typeof effort === "string" && effort) out.output_config = { effort: effort };
    return out;
  }

  function outHeaders(init, p) {
    var src = new Headers(init.headers || {});
    var h = new Headers();
    ["content-type", "accept", "anthropic-version"].forEach(function (k) {
      var v = src.get(k);
      if (v) h.set(k, v);
    });
    if (!h.has("content-type")) h.set("content-type", "application/json");
    h.set("x-api-key", String(p.apiKey).trim()); // never the Anthropic OAuth Authorization
    if (p.headers && typeof p.headers === "object") {
      Object.keys(p.headers).forEach(function (k) {
        if (typeof p.headers[k] === "string") h.set(k, p.headers[k]);
      });
    }
    return h;
  }

  function jsonResponse(status, obj) {
    return new Response(JSON.stringify(obj), { status: status, headers: { "content-type": "application/json" } });
  }
  function errorResponse(status, type, message) {
    return jsonResponse(status, { type: "error", error: { type: type, message: message } });
  }

  // ---- routing --------------------------------------------------------------
  function quickMatch(bodyText) {
    var hit = false;
    routes.forEach(function (_r, alias) { if (!hit && bodyText.indexOf('"' + alias) !== -1) hit = true; });
    return hit;
  }

  function route(rawFetch, input, init) {
    var url = typeof input === "string" ? input : input instanceof URL ? input.href : null;
    if (!url || !init || typeof init.body !== "string") return null;
    var pathname = new URL(url).pathname;
    var isMessages = /\/v1\/messages$/.test(pathname);
    var isCount = /\/v1\/messages\/count_tokens$/.test(pathname);
    if (!isMessages && !isCount) return null;
    var maybeWebSearch = !!webSearchRoute && isMessages && init.body.indexOf('"web_search') !== -1;
    if (!quickMatch(init.body) && !maybeWebSearch) return null;

    var body = JSON.parse(init.body);
    var requested = String(body.model || "").replace(/\[\w+\]$/, "").trim();
    var r = routes.get(requested);
    var viaWebSearch = false;
    // The exact shape of the CLI's web-search sub-request: a single tool, the
    // server-side web_search one. A conversation listing web_search among other
    // tools is not touched.
    if (!r && maybeWebSearch && Array.isArray(body.tools) && body.tools.length === 1 &&
        body.tools[0] && /^web_search/.test(body.tools[0].type || "")) {
      r = webSearchRoute;
      viaWebSearch = true;
    }
    if (!r) return null;
    var p = r.provider, m = r.model;

    if (isCount) {
      return Promise.resolve(jsonResponse(200, { input_tokens: Math.ceil(init.body.length / 4) }));
    }
    if (!providerBase(p)) {
      return Promise.resolve(errorResponse(400, "invalid_request_error",
        "claude-desktop-extra custom models: provider \"" + p.id + "\" has no baseUrl"));
    }
    if (!providerKeyOk(p)) {
      log("refused: no API key for provider " + p.id + " (model " + m.id + ")");
      // 400, not 401: on 401 the CLI refreshes its OAuth token and retries forever.
      return Promise.resolve(errorResponse(400, "invalid_request_error",
        "claude-desktop-extra custom models: no API key configured for provider \"" + p.id +
        "\" (customModels.providers[].apiKey in claude-desktop-extra.jsonc)"));
    }

    var target = providerBase(p) + "/v1/messages";
    function send(stripThinking) {
      return rawFetch(target, {
        method: init.method || "POST",
        headers: outHeaders(init, p),
        body: JSON.stringify(sanitize(body, r, { stripThinking: stripThinking })),
        signal: init.signal
      });
    }
    var n = Array.isArray(body.messages) ? body.messages.length : 0;
    log("-> " + p.id + "/" + m.id + (viaWebSearch ? " (web search, instead of " + body.model + ")" : "") +
      " stream=" + !!body.stream + " messages=" + n + " tools=" + (Array.isArray(body.tools) ? body.tools.length : 0));

    return (async function () {
      var res = await send(false);
      if (res.status === 400) {
        // History carrying thinking blocks signed by Claude (model switched
        // mid-session): the provider may refuse them - retry without.
        var text = "";
        try { text = await res.clone().text(); } catch (e) {}
        if (/thinking|signature/i.test(text)) {
          log("400 thinking/signature -> retry without thinking blocks: " + text.slice(0, 200));
          res = await send(true);
        }
      }
      if (!res.ok) {
        var t2 = "";
        try { t2 = await res.clone().text(); } catch (e) {}
        log("<- " + p.id + "/" + m.id + " HTTP " + res.status + " " + t2.slice(0, 300));
      }
      return res;
    })();
  }

  var rawFetch = globalThis.fetch;
  var hooked = function fetch(input, init) {
    try {
      var r = route(rawFetch, input, init);
      if (r) return r;
    } catch (e) {
      log("fetch hook: " + (e && e.message) + " -> passthrough");
    }
    return rawFetch.call(this, input, init);
  };
  Object.keys(rawFetch).forEach(function (k) { hooked[k] = rawFetch[k]; }); // Bun: fetch.preconnect...
  globalThis.fetch = hooked;

  var names = [];
  routes.forEach(function (r, alias) { names.push(alias + " -> " + r.provider.id + "/" + r.model.id); });
  log("active: " + names.join(", ") + (webSearchRoute ? "; web search -> " + webSearchRoute.model.id : ""));

  if (SELFTEST) {
    globalThis.__cdbCustomModelsPreload = { sanitize: sanitize, route: route, routes: routes, rawFetch: rawFetch };
  }
})();
