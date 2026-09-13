#!/usr/bin/env node
/*
 * test-custom-models-main.mjs - the main-process half of the custom models
 * feature. A clean patch run says nothing about how the config is merged,
 * what the bootstrap patch looks like or what reaches the CLI's environment,
 * so this suite runs the real module with electron shimmed and a temporary
 * profile dir, and drives the CDP Fetch flow with a fake webContents.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

const PRELOAD_STUB = "/*preload*/";

// Runs the module; returns the IPC handlers, the global it exports, the
// web-contents-created listener and the diag lines it logged.
function load(profileDir, env) {
  const handlers = {};
  const appListeners = {};
  const diag = [];
  const electron = {
    app: {
      getPath: () => { if (profileDir === null) throw new Error("no app"); return profileDir; },
      on: (ev, fn) => { appListeners[ev] = fn; }
    },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }
  };
  const src = readFileSync(join(ROOT, "js/custom_models_main.js"), "utf8")
    .replace('"__CDB_CM_PRELOAD_SRC__"', JSON.stringify(PRELOAD_STUB));
  const sandbox = { require: (m) => (m === "electron" ? electron : Module.createRequire(import.meta.url)(m)),
    process: { platform: "linux", env: env || {} }, console, setTimeout, clearTimeout, Buffer, URL, AbortController,
    fetch: (url, init) => { sandbox.__fetchCalls.push({ url, init }); return sandbox.__fetchImpl(url, init); } };
  sandbox.__fetchCalls = [];
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ id: "msg" }), { status: 200 }));
  sandbox.globalThis = sandbox;
  sandbox.__cdbDiag = (l) => diag.push(l);
  vm.runInNewContext(src, vm.createContext(sandbox));
  return { h: handlers, api: sandbox.__cdbCustomModels, on: appListeners, diag, sandbox };
}

function sender(url) { return { sender: { getURL: () => url, isDestroyed: () => false } }; }
const okSenderEv = sender("https://claude.ai/code");

const PROVIDERS = `{
  // hand-owned config
  "customModels": {
    "providers": [{
      "id": "deepseek",
      "baseUrl": "https://api.deepseek.com/anthropic/",
      "apiKey": "sk-test-1234567890",
      "webSearch": "deepseek-flash",
      "models": [
        { "id": "deepseek-flash", "name": "DeepSeek Flash", "description": "V4.1 Flash", "context1m": true },
        { "id": "deepseek-pro", "thinking": false, "vision": false, "badge": "slow" }
      ]
    }]
  }
}
`;

// The live shape of 2026-09-13 (French locale): the desktop Code tab is the
// `ccd` surface, labels are localised server-side, the default effort wears a
// badge, max carries a tooltip.
const OPUS_THINKING = {
  type: "effort",
  description: "Un effort plus élevé signifie des réponses plus approfondies.",
  effort_options: [
    { id: "low", name: "Faible" }, { id: "medium", name: "Moyen" },
    { id: "high", name: "Élevé", badge: { message: "Par défaut", variant: "neutral" } },
    { id: "xhigh", name: "Extra" },
    { id: "max", name: "Max", tooltip: { content: "Peut utiliser un nombre excessif de jetons." } },
    { id: "ultracode", name: "Ultracode" }
  ]
};
function bootstrap() {
  return {
    account: { x: 1 },
    claude_ai_available_models: { models: [{ model_id: "claude-opus-5", minimum_tier: "pro" }] },
    model_selector_config: [
      { id: "cowork", models: [{ id: "claude-opus-5", name: "Opus 5", section: "main",
        thinking: Object.assign({}, OPUS_THINKING, { type: "effort_and_mode", mode_options: [{ id: "auto", name: "Réflexion" }, { id: "off", name: "Désactivé" }] }) }] },
      { id: "ccd", settings_vocabulary: { effort_level: { low: 1 } }, models: [
        { id: "claude-opus-5", name: "Opus 5", short_name: "Opus", section: "main",
          capabilities: { compass: true, gsuite_tools: true, mm_images: true, mm_pdf: true, web_search: true },
          thinking: OPUS_THINKING, quick_select: true },
        { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", short_name: "Haiku", section: "main", thinking: { type: "none" }, quick_select: true },
        { id: "claude-opus-4-8", name: "Opus 4.8", short_name: "Opus", section: "overflow", thinking: OPUS_THINKING }
      ] },
      { id: "chat", models: [{ id: "claude-opus-5", name: "Opus 5" }] }
    ],
    model_selector_state: [{ id: "ccd", model: "claude-opus-5" }]
  };
}

// --- config: nothing configured ---------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h, api } = load(dir);
  ok(typeof h["cdb-cm:pref-read"] === "function", "registers cdb-cm:pref-read");
  ok(typeof h["cdb-cm:pref-set"] === "function", "registers cdb-cm:pref-set");
  const r = await h["cdb-cm:pref-read"](okSenderEv);
  ok(r.ok === true && r.enabled === false && r.configured === false && r.source === "default",
     "no config: off, not configured");
  const set = await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(set.ok === false && /no custom model/.test(set.error), "cannot switch on with nothing to list");
  ok(!existsSync(join(dir, "claude-desktop-extra.json")), "a refused switch-on writes nothing");
  ok(JSON.stringify(api.cliEnv()) === "{}", "cliEnv() is {} when nothing is configured");
  ok(api.enrichBootstrap(bootstrap(), null) === null, "enrichBootstrap is a no-op without config");
  rmSync(dir, { recursive: true, force: true });
}

// --- config: providers in the .jsonc, switch in the .json ---------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  writeFileSync(join(dir, "claude-desktop-extra.json"), '{\n  "someOtherExtra": "keep"\n}\n');
  const { h, api, diag } = load(dir);
  const r = await h["cdb-cm:pref-read"](okSenderEv);
  ok(r.ok === true && r.enabled === true && r.configured === true && r.source === "default",
     "providers with no enabled flag: on by default");
  ok(r.models === 2 && r.providers.length === 1 && r.providers[0].id === "deepseek" && r.providers[0].keyOk === true,
     "the summary counts 2 models from provider deepseek with a key");
  ok(JSON.stringify(r.surfaces) === '["ccd"]', "surfaces default to ccd (the desktop Code tab) only");

  const cfg = api.readConfig();
  ok(cfg.providers[0].baseUrl === "https://api.deepseek.com/anthropic", "baseUrl loses its trailing slash");
  ok(cfg.providers[0].models[0].alias === "claude-deepseek-flash", "ids are exposed to the CLI as claude-<id>");
  ok(cfg.providers[0].models[1].thinking === false && cfg.providers[0].models[1].vision === false,
     "thinking:false and vision:false are honoured");

  // The switch writes the .json only, under customModels.enabled, and every
  // other key survives.
  const off = await h["cdb-cm:pref-set"](okSenderEv, false);
  ok(off.ok === true && off.enabled === false && off.source === "json", "pref-set(false) turns it off via the .json");
  const onDisk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(onDisk.customModels && onDisk.customModels.enabled === false && onDisk.someOtherExtra === "keep",
     "the .json carries customModels.enabled=false and keeps the other keys");
  ok(JSON.stringify(api.cliEnv()) === "{}", "cliEnv() is {} while switched off");
  ok(api.enrichBootstrap(bootstrap(), null) === null, "no bootstrap patch while switched off");
  const back = await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(back.ok === true && back.enabled === true, "pref-set(true) turns it back on");
  await new Promise((r) => setTimeout(r, 5));
  ok(diag.some((l) => /\[custom-models\] installed \(main\); 2 model\(s\) from 1 provider\(s\), on \(source: json\), surfaces ccd/.test(l)),
     "the deferred install line goes through __cdbDiag: " + diag.filter((l) => /installed/.test(l)).join(" | "));
  rmSync(dir, { recursive: true, force: true });
}

// --- config: enabled in the .jsonc locks the switch ---------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"),
    PROVIDERS.replace('"providers"', '"enabled": false,\n    "providers"'));
  const jsonPath = join(dir, "claude-desktop-extra.json");
  writeFileSync(jsonPath, '{\n  "customModels": { "enabled": true }\n}\n');
  const { h } = load(dir);
  const r = await h["cdb-cm:pref-read"](okSenderEv);
  ok(r.enabled === false && r.lockedByJsonc === true && r.source === "jsonc-locked",
     "the .jsonc's enabled wins over the .json's and reports locked");
  const set = await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(set.ok === false && /claude-desktop-extra\.jsonc/.test(set.error), "pref-set refuses while locked");
  ok(readFileSync(jsonPath, "utf8") === '{\n  "customModels": { "enabled": true }\n}\n',
     "a refused pref-set does not touch the .json");
  rmSync(dir, { recursive: true, force: true });
}

// --- config: key sources and invalid entries ----------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "ds.key"), "sk-from-file-123456\n");
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), JSON.stringify({ customModels: { providers: [
    { id: "a", baseUrl: "https://a.example/v1", apiKeyFile: join(dir, "ds.key"), models: [{ id: "m1" }] },
    { id: "b", baseUrl: "https://b.example", apiKeyEnv: "CDB_TEST_KEY", models: [{ id: "m2" }, { id: "m1" }] },
    { id: "c", baseUrl: "not a url", apiKey: "sk-xxxxxxxxxx", models: [{ id: "m3" }] },
    { id: "d", baseUrl: "https://d.example", apiKey: "sk-xxxxxxxxxx", models: [{ id: "bad id" }, { id: 42 }] },
    "junk"
  ] } }));
  const { api, diag } = load(dir, { CDB_TEST_KEY: "sk-from-env-123456" });
  const cfg = api.readConfig();
  ok(cfg.providers.length === 2, "providers without a usable baseUrl or model are dropped (" + cfg.providers.length + ")");
  ok(cfg.providers[0].apiKey === "sk-from-file-123456", "apiKeyFile is read and trimmed");
  ok(cfg.providers[1].apiKey === "sk-from-env-123456", "apiKeyEnv is read from the app's environment");
  ok(cfg.providers[1].models.length === 1 && cfg.providers[1].models[0].id === "m2",
     "a model id listed twice keeps the first occurrence only");
  await new Promise((r) => setTimeout(r, 5));
  ok(diag.some((l) => /provider c: baseUrl/.test(l)), "a bad baseUrl is logged once: " + diag.filter((l) => /config:/.test(l)).length);
  ok(diag.some((l) => /provider d: models\[0\]/.test(l)), "a bad model id is logged");
  rmSync(dir, { recursive: true, force: true });
}

// --- bootstrap enrichment -----------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  const { api } = load(dir);
  const cfg = api.readConfig();
  const boot = bootstrap();
  const out = api.enrichBootstrap(boot, cfg);
  ok(out === boot, "enrichBootstrap returns the same object, patched in place");
  const ccd = out.model_selector_config.find((s) => s.id === "ccd").models;
  const cowork = out.model_selector_config.find((s) => s.id === "cowork").models;
  ok(cowork.length === 1, "surfaces not configured (cowork) are untouched");
  ok(ccd.length === 6, "ccd gets 3 entries: flash, flash[1m], pro (" + ccd.length + ")");
  ok(ccd[0].id === "claude-opus-5" && ccd[2].id === "claude-opus-4-8", "Anthropic's entries stay first and unchanged");
  const flash = ccd[3], flash1m = ccd[4], pro = ccd[5];
  ok(flash.id === "claude-deepseek-flash" && flash.name === "DeepSeek Flash" && flash.short_name === "DeepSeek Flash" &&
     flash.description === "V4.1 Flash", "the entry carries the configured name, short name and description");
  ok(flash.section === "main" && flash.quick_select === true, "listed in the main section with quick select, like Anthropic's current models");
  ok(flash.capabilities && flash.capabilities.mm_images === true && flash.capabilities.mm_pdf === false &&
     flash.capabilities.web_search === true, "capabilities: images from vision, no pdf, web search on");
  ok(flash.thinking.type === "effort" && flash.thinking.effort_options.map((o) => o.id).join(",") === "low,medium,high,xhigh,max",
     "thinking is type effort with the five levels (no ultracode)");
  ok(flash.thinking.effort_options.map((o) => o.name).join(",") === "Faible,Moyen,Élevé,Extra,Max",
     "effort labels are borrowed from the surface's own (localised) Opus entry");
  ok(flash.thinking.description === OPUS_THINKING.description, "so is the effort description");
  const rec = flash.thinking.effort_options.filter((o) => o.recommended === true);
  ok(rec.length === 1 && rec[0].id === "xhigh" && rec[0].badge && rec[0].badge.message === "Par défaut",
     "xhigh is the recommended effort and wears the surface's own Default badge");
  ok(!flash.thinking.effort_options[2].badge, "the badge is not left on high as well");
  ok(flash.thinking.effort_options[4].tooltip && /excessif/.test(flash.thinking.effort_options[4].tooltip.content),
     "max keeps the surface's tooltip");
  ok(!("mode_options" in flash.thinking), "no mode options on a surface whose menu has none (ccd)");
  ok(flash1m.id === "claude-deepseek-flash[1m]" && flash1m.supports_1m_context === true &&
     flash1m.description === "1M context window", "context1m adds the [1m] variant in upstream's 3p shape");
  ok(pro.id === "claude-deepseek-pro" && pro.thinking.type === "none" && pro.capabilities.mm_images === false &&
     pro.badge && pro.badge.message === "slow", "thinking:false is type none; vision:false drops images; badge is neutral");
  ok(JSON.stringify(out.model_selector_state) === JSON.stringify(bootstrap().model_selector_state) &&
     JSON.stringify(out.claude_ai_available_models) === JSON.stringify(bootstrap().claude_ai_available_models),
     "model_selector_state and claude_ai_available_models are not touched");
  ok(api.enrichBootstrap(out, cfg) === null, "a second pass finds every entry present and changes nothing");
  ok(api.enrichBootstrap({ account: {} }, cfg) === null, "a response without model_selector_config is left alone");

  // A surface whose menu carries mode options (cowork) gets effort_and_mode
  // with those options copied; a surface with no template falls back to
  // English labels; an overflow section is honoured.
  const cfg2 = JSON.parse(JSON.stringify(cfg));
  cfg2.surfaces = ["cowork", "chat"];
  cfg2.providers[0].models[0].section = "overflow";
  const out2 = api.enrichBootstrap(bootstrap(), cfg2);
  const cw = out2.model_selector_config.find((s) => s.id === "cowork").models[1];
  ok(cw.thinking.type === "effort_and_mode" && cw.thinking.mode_options.map((o) => o.id).join(",") === "auto,off" &&
     cw.thinking.mode_options[0].name === "Réflexion", "a surface with mode options: effort_and_mode, options copied");
  ok(cw.section === "overflow" && !("quick_select" in cw), "section overflow: no quick select");
  const ch = out2.model_selector_config.find((s) => s.id === "chat").models[1];
  ok(ch.thinking.effort_options.map((o) => o.name).join(",") === "Low,Medium,High,Extra,Max" &&
     ch.thinking.effort_options[3].badge.message === "Default", "no template on the surface: English fallback labels");
  rmSync(dir, { recursive: true, force: true });
}

// --- CLI environment ----------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  const { api } = load(dir, { BUN_OPTIONS: "--smol" });
  const env = api.cliEnv();
  const preloadPath = join(dir, "custom-models", "preload.js");
  ok(env.BUN_OPTIONS === "--smol --preload=" + preloadPath,
     "BUN_OPTIONS appends our preload to the app's own value: " + env.BUN_OPTIONS);
  ok(existsSync(preloadPath) && readFileSync(preloadPath, "utf8") === PRELOAD_STUB,
     "the preload is written under <userData>/custom-models/");
  ok(env.CDB_CUSTOM_MODELS_LOG === join(dir, "logs", "custom-models.log"), "the CLI log lands in <userData>/logs/");
  const payload = JSON.parse(env.CDB_CUSTOM_MODELS_JSON);
  ok(payload.providers.length === 1 && payload.providers[0].apiKey === "sk-test-1234567890" &&
     payload.providers[0].baseUrl === "https://api.deepseek.com/anthropic" && payload.providers[0].webSearch === "deepseek-flash",
     "the payload carries endpoint, key and web-search route");
  ok(payload.providers[0].models.length === 2 && payload.providers[0].models[1].thinking === false,
     "the payload carries the per-model routing flags");
  ok(!("name" in payload.providers[0].models[0]), "picker-only fields stay out of the CLI payload");
  writeFileSync(preloadPath, "stale");
  api.cliEnv();
  ok(readFileSync(preloadPath, "utf8") === PRELOAD_STUB, "a stale preload is rewritten");
  const { api: api2 } = load(dir, {});
  ok(api2.cliEnv().BUN_OPTIONS === "--preload=" + preloadPath, "no prior BUN_OPTIONS: ours alone");
  rmSync(dir, { recursive: true, force: true });
}

// --- CDP Fetch flow -----------------------------------------------------------
function fakeWc(url) {
  const sent = [];
  const listeners = {};
  const dbgListeners = {};
  const wc = {
    getURL: () => url,
    on: (ev, fn) => { listeners[ev] = fn; },
    debugger: {
      attached: 0,
      attach: function () { this.attached++; },
      on: (ev, fn) => { dbgListeners[ev] = fn; },
      sendCommand: (method, params) => {
        sent.push({ method, params });
        if (method === "Fetch.getResponseBody") return Promise.resolve(wc.__body);
        return Promise.resolve({});
      }
    }
  };
  return { wc, sent, listeners, dbgListeners };
}
async function settle() { await new Promise((r) => setTimeout(r, 10)); }
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  const { on } = load(dir);
  ok(typeof on["web-contents-created"] === "function", "listens for web-contents-created");

  const other = fakeWc("https://example.com/");
  on["web-contents-created"]({}, other.wc);
  other.listeners["did-start-navigation"]({ url: "https://example.com/", isMainFrame: true });
  ok(other.wc.debugger.attached === 0, "a non-claude webContents is never attached");

  const f = fakeWc("https://claude.ai/code");
  on["web-contents-created"]({}, f.wc);
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: false });
  ok(f.wc.debugger.attached === 0, "a subframe navigation does not attach");
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 1, "a claude.ai main-frame navigation attaches exactly once");
  const enable = f.sent.find((s) => s.method === "Fetch.enable");
  ok(!!enable && enable.params.patterns.every((p) => p.requestStage === "Response" && /(api|edge-api)\/bootstrap/.test(p.urlPattern)),
     "Fetch.enable pauses only bootstrap responses");
  ok(!!enable && enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/edge-api/bootstrap/*/app_start*") &&
     enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/api/bootstrap/*/app_start*") &&
     enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/api/bootstrap"),
     "both the /api and the /edge-api spellings of app_start (and the bare endpoint) are covered");
  ok(!!enable && !enable.params.patterns.some((p) => /model_selector_state|user_settings/.test(p.urlPattern)),
     "the debug-only patterns are not armed outside CDB_CUSTOM_MODELS_DEBUG");

  // A 200 bootstrap: fulfilled with the enriched body, hop headers dropped.
  const body = JSON.stringify(bootstrap());
  f.wc.__body = { body: Buffer.from(body, "utf8").toString("base64"), base64Encoded: true };
  f.sent.length = 0;
  f.dbgListeners.message({}, "Fetch.requestPaused", {
    requestId: "r1", request: { url: "https://claude.ai/api/bootstrap/org-1" }, responseStatusCode: 200,
    responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "content-length", value: String(body.length) }, { name: "Content-Encoding", value: "br" }]
  });
  await settle();
  const ful = f.sent.find((s) => s.method === "Fetch.fulfillRequest");
  ok(!!ful && ful.params.requestId === "r1" && ful.params.responseCode === 200, "a 200 bootstrap is fulfilled");
  if (ful) {
    const names = ful.params.responseHeaders.map((h) => h.name.toLowerCase());
    ok(names.join(",") === "content-type", "content-length and content-encoding are dropped: " + names.join(","));
    const out = JSON.parse(Buffer.from(ful.params.body, "base64").toString("utf8"));
    const ccd = out.model_selector_config.find((s) => s.id === "ccd").models.map((m) => m.id);
    ok(ccd.join(",") === "claude-opus-5,claude-haiku-4-5-20251001,claude-opus-4-8,claude-deepseek-flash,claude-deepseek-flash[1m],claude-deepseek-pro",
       "the fulfilled body carries Anthropic's models then ours: " + ccd.join(","));
    ok(out.account && out.account.x === 1, "the rest of the bootstrap is preserved");
  }
  ok(!f.sent.some((s) => s.method === "Fetch.continueRequest"), "a fulfilled request is not also continued");

  // Non-200, error, and a body without the field: released untouched.
  f.sent.length = 0;
  f.dbgListeners.message({}, "Fetch.requestPaused", { requestId: "r2", request: { url: "x" }, responseStatusCode: 401, responseHeaders: [] });
  f.dbgListeners.message({}, "Fetch.requestPaused", { requestId: "r3", request: { url: "x" }, responseErrorReason: "Failed" });
  f.wc.__body = { body: JSON.stringify({ hello: 1 }), base64Encoded: false };
  f.dbgListeners.message({}, "Fetch.requestPaused", { requestId: "r4", request: { url: "x" }, responseStatusCode: 200, responseHeaders: [] });
  f.wc.__body = { body: "not json", base64Encoded: false };
  f.dbgListeners.message({}, "Fetch.requestPaused", { requestId: "r5", request: { url: "x" }, responseStatusCode: 200, responseHeaders: [] });
  await settle();
  const cont = f.sent.filter((s) => s.method === "Fetch.continueRequest").map((s) => s.params.requestId).sort().join(",");
  ok(cont === "r2,r3,r4,r5", "every non-patchable pause is continued: " + cont);
  ok(!f.sent.some((s) => s.method === "Fetch.fulfillRequest"), "nothing is fulfilled in those cases");

  // Detach -> re-attach on the next navigation.
  f.dbgListeners.detach({}, "target closed");
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 2, "re-attaches after a detach");

  // Legacy positional signature still works.
  const g = fakeWc("https://claude.com/code");
  on["web-contents-created"]({}, g.wc);
  g.listeners["did-start-navigation"]({}, "https://claude.com/code", false, true);
  ok(g.wc.debugger.attached === 1, "the positional did-start-navigation arguments are understood");
  rmSync(dir, { recursive: true, force: true });
}


// --- the Models panel's IPC: editing, secrets, locks -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h, sandbox } = load(dir);
  let r = await h["cdb-cm:config-read"](okSenderEv);
  ok(r.ok === true && r.configured === false && r.providers.length === 0 && Array.isArray(r.presets) && r.presets[0].id === "deepseek",
     "config-read on an empty profile: nothing configured, presets offered");
  ok(r.paths.secrets === join(dir, "custom-models", "secrets.json"), "config-read names the secrets file");

  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "bad id", baseUrl: "https://x", apiKey: "" });
  ok(r.ok === false && /provider id/.test(r.error), "a provider id with a space is refused");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "api.deepseek.com", apiKey: "" });
  ok(r.ok === false && /http/.test(r.error), "a base URL without a scheme is refused");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic/", apiKey: "short" });
  ok(r.ok === false && /API key/.test(r.error), "a five-character key is refused");

  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic/", apiKey: "sk-secret-1234567890", webSearch: "deepseek-flash" });
  ok(r.ok === true && r.providers.length === 1 && r.providers[0].id === "ds" && r.providers[0].keyOk === true && r.providers[0].keySource === "stored",
     "provider-set adds the provider with a stored key");
  ok(r.configured === false && r.providers[0].models.length === 0, "a provider without a model is listed but not usable");
  const json = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(json.customModels.providers[0].apiKeyStored === true && !("apiKey" in json.customModels.providers[0]) &&
     json.customModels.providers[0].baseUrl === "https://api.deepseek.com/anthropic",
     "the .json carries apiKeyStored, not the key, and the trimmed URL");
  ok(!/sk-secret-1234567890/.test(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")), "the key is not in the .json");
  const secretsPath = join(dir, "custom-models", "secrets.json");
  ok(JSON.parse(readFileSync(secretsPath, "utf8")).ds === "sk-secret-1234567890", "the key is in the secrets file");
  ok((statSync(secretsPath).mode & 0o777) === 0o600 && (statSync(join(dir, "custom-models")).mode & 0o777) === 0o700,
     "secrets.json is 0600 in a 0700 directory");
  ok(!/sk-secret/.test(JSON.stringify(r)), "no key value in the config-read answer");

  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "DeepSeek Flash", description: "", badge: "",
    thinking: true, vision: true, context1m: false, effortDefault: "xhigh" });
  ok(r.ok === true && r.configured === true && r.providers[0].models.length === 1 && r.providers[0].models[0].alias === "claude-deepseek-flash",
     "model-set adds the model and the provider becomes usable");
  const j2 = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(JSON.stringify(j2.customModels.providers[0].models[0]) === JSON.stringify({ id: "deepseek-flash", name: "DeepSeek Flash" }),
     "defaults (thinking, vision, xhigh) are not written out: " + JSON.stringify(j2.customModels.providers[0].models[0]));
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "Flash", thinking: false, vision: false, effortDefault: "high" });
  ok(r.ok === true && r.providers[0].models.length === 1 && r.providers[0].models[0].name === "Flash" && r.providers[0].models[0].thinking === false,
     "model-set on an existing id updates in place");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "bad id" });
  ok(r.ok === false && /model id/.test(r.error), "a bad model id is refused");
  r = await h["cdb-cm:model-set"](okSenderEv, "nope", { id: "x" });
  ok(r.ok === false && /not in/.test(r.error), "a model for an unknown provider is refused");

  // Editing the provider without a key keeps the stored one; the enabled
  // switch now works since a model exists.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "", webSearch: "" });
  ok(r.ok === true && r.providers[0].keyOk === true && r.providers[0].keySource === "stored" && r.providers[0].webSearch === "",
     "an empty key field keeps the stored key; an empty web-search clears it");
  r = await h["cdb-cm:pref-set"](okSenderEv, false);
  ok(r.ok === true && r.enabled === false, "the switch works once a model exists");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers.length === 1,
     "flipping the switch keeps the providers");

  // The connectivity test: one token to the first model with the stored key.
  r = await h["cdb-cm:provider-test"](okSenderEv, "ds");
  ok(r.ok === true && r.status === 200 && r.model === "deepseek-flash", "provider-test reports the answer");
  const call = sandbox.__fetchCalls[0];
  ok(call && call.url === "https://api.deepseek.com/anthropic/v1/messages" && call.init.headers["x-api-key"] === "sk-secret-1234567890" &&
     JSON.parse(call.init.body).max_tokens === 1 && JSON.parse(call.init.body).model === "deepseek-flash",
     "it posts one token to <baseUrl>/v1/messages with the stored key");
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
  r = await h["cdb-cm:provider-test"](okSenderEv, "ds");
  ok(r.ok === false && r.status === 401 && /invalid api key/.test(r.error), "a provider error is reported with its message");
  r = await h["cdb-cm:provider-test"](okSenderEv, "nope");
  ok(r.ok === false && /unknown provider/.test(r.error), "testing an unknown provider is refused");

  // Delete: model, then provider (with its secret).
  r = await h["cdb-cm:model-delete"](okSenderEv, "ds", "deepseek-flash");
  ok(r.ok === true && r.providers[0].models.length === 0 && r.configured === false, "model-delete empties the provider");
  r = await h["cdb-cm:provider-delete"](okSenderEv, "ds");
  ok(r.ok === true && r.providers.length === 0, "provider-delete removes it");
  ok(!("ds" in JSON.parse(readFileSync(secretsPath, "utf8"))), "and its secret");
  const j3 = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(!("customModels" in j3) || !("providers" in j3.customModels), "an emptied provider list is dropped from the .json");
  rmSync(dir, { recursive: true, force: true });
}

// --- locked (.jsonc) providers coexist with .json ones -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  const { h, api } = load(dir);
  let r = await h["cdb-cm:provider-set"](okSenderEv, { id: "deepseek", baseUrl: "https://elsewhere.example", apiKey: "" });
  ok(r.ok === false && /claude-desktop-extra\.jsonc/.test(r.error), "a .jsonc provider cannot be edited from the panel");
  r = await h["cdb-cm:model-set"](okSenderEv, "deepseek", { id: "x" });
  ok(r.ok === false && /claude-desktop-extra\.jsonc/.test(r.error), "nor its models");
  r = await h["cdb-cm:provider-delete"](okSenderEv, "deepseek");
  ok(r.ok === false, "nor removed");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "gw", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890" });
  ok(r.ok === true && r.providers.length === 2 && r.providers[0].locked === true && r.providers[1].locked === false,
     "a .json provider sits next to the locked .jsonc one");
  r = await h["cdb-cm:model-set"](okSenderEv, "gw", { id: "deepseek-flash" });
  ok(r.ok === false && /already used/.test(r.error), "a model id already served by another provider is refused");
  r = await h["cdb-cm:model-set"](okSenderEv, "gw", { id: "gw-model", name: "GW" });
  ok(r.ok === true && r.models === 3, "three models across both providers");
  const cfg = api.readConfig();
  ok(cfg.providers.length === 2 && cfg.providers[1].apiKey === "sk-gw-1234567890" && cfg.providers[1].keySource === "stored",
     "the routing config resolves the stored key of the .json provider");
  const env = api.cliEnv();
  const payload = JSON.parse(env.CDB_CUSTOM_MODELS_JSON);
  ok(payload.providers.length === 2 && payload.providers[1].apiKey === "sk-gw-1234567890", "and hands it to the CLI");
  rmSync(dir, { recursive: true, force: true });
}

// --- sender checks ------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h } = load(dir);
  const res = await h["cdb-cm:pref-set"](sender("https://evil.example/?next=claude.ai"), true);
  ok(res.ok === false && /sender/.test(res.error), "rejects a sender whose URL merely contains claude.ai");
  const res2 = await h["cdb-cm:pref-read"]({ sender: { getURL: () => "https://claude.ai/" } });
  ok(res2.ok === false, "a sender without isDestroyed() is rejected (fails closed)");
  const bad = await h["cdb-cm:pref-set"](okSenderEv, "yes");
  ok(bad.ok === false, "pref-set rejects a non-boolean");
  for (const u of ["https://claude.ai/x", "https://preview.claude.ai/x", "https://claude.com/x", "https://preview.claude.com/x"]) {
    const r = await h["cdb-cm:pref-read"](sender(u));
    ok(r.ok === true, "accepts " + u);
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
