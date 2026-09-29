#!/usr/bin/env node
/*
 * test-custom-models-main.mjs - the main-process half of the custom models
 * feature. A clean patch run says nothing about how the config is merged,
 * what the bootstrap patch looks like or what reaches the CLI's environment,
 * so this suite runs the real module with electron shimmed and a temporary
 * profile dir, and drives the CDP Fetch flow with a fake webContents.
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, statSync, mkdirSync, chmodSync } from "node:fs";
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
// The SDK query's transport as sub-patch C passes it: a local Code session
// spawned with cliEnv() carries CDB_CUSTOM_MODELS_JSON in options.env.
const LOCAL = { options: { env: { CDB_CUSTOM_MODELS_JSON: "{}" } } };
// Community features are off by default: a test that wants the feature on
// says so the way the switch does, in the .json (merged with what is there).
function switchOn(dir) {
  const p = join(dir, "claude-desktop-extra.json");
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  cur.customModels = Object.assign({}, cur.customModels, { enabled: true });
  writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
}

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
        { "id": "deepseek-pro", "thinking": false, "vision": false, "webSearch": false, "badge": "slow" }
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
      // The logical Code surface: what the session logic reads (effort
      // options, available ids) and what the page persists state for.
      { id: "code", models: [
        { id: "claude-opus-5", name: "Opus 5", section: "main", thinking: OPUS_THINKING },
        { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", section: "main", thinking: { type: "none" } }
      ] },
      { id: "chat", models: [{ id: "claude-opus-5", name: "Opus 5" }] }
    ],
    model_selector_state: [{ id: "ccd", model: "claude-opus-5" }, { id: "code", model: "claude-opus-5" }]
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
  ok(r.ok === true && r.enabled === false && r.configured === true && r.source === "default",
     "providers with no enabled flag: off by default, like every community feature");
  ok(JSON.stringify(api.cliEnv()) === "{}" && api.enrichBootstrap(bootstrap(), api.readConfig().enabled ? api.readConfig() : null) === null,
     "configured but never switched on: no CLI env, no bootstrap patch");
  const on = await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(on.ok === true && on.enabled === true && on.source === "json", "pref-set(true) turns it on via the .json");
  ok(r.models === 2 && r.providers.length === 1 && r.providers[0].id === "deepseek" && r.providers[0].keyOk === true,
     "the summary counts 2 models from provider deepseek with a key");
  ok(JSON.stringify(r.surfaces) === '["ccd","code"]', "surfaces default to ccd and code - the two the desktop Code tab reads");

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
  ok(diag.some((l) => /\[custom-models\] installed \(main\); 2 model\(s\) from 1 provider\(s\), on \(source: json\), surfaces ccd,code/.test(l)),
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
  switchOn(dir);
  const { api, h } = load(dir);
  const cfg = api.readConfig();
  const boot = bootstrap();
  const out = api.enrichBootstrap(boot, cfg);
  ok(out === boot, "enrichBootstrap returns the same object, patched in place");
  const ccd = out.model_selector_config.find((s) => s.id === "ccd").models;
  const code = out.model_selector_config.find((s) => s.id === "code").models;
  const cowork = out.model_selector_config.find((s) => s.id === "cowork").models;
  ok(cowork.length === 1, "surfaces not configured (cowork) are untouched");
  ok(ccd.length === 6, "ccd gets 3 entries: flash, flash[1m], pro (" + ccd.length + ")");
  ok(code.length === 5 && code.slice(2).map((e) => e.id).join(",") === "claude-deepseek-flash,claude-deepseek-flash[1m],claude-deepseek-pro",
     "the code surface - the one the effort menu and the available ids are read from - gets the same entries");
  ok(code[2].thinking.effort_options.length === 5 && code[2].thinking.effort_options[2].name === "Élevé",
     "with the effort menu borrowed from that surface's own Opus entry");
  ok(ccd[0].id === "claude-opus-5" && ccd[2].id === "claude-opus-4-8", "Anthropic's entries stay first and unchanged");
  const flash = ccd[3], flash1m = ccd[4], pro = ccd[5];
  ok(flash.id === "claude-deepseek-flash" && flash.name === "DeepSeek Flash" && flash.short_name === "DeepSeek Flash" &&
     flash.description === "V4.1 Flash", "the entry carries the configured name, short name and description");
  ok(flash.section === "main" && flash.quick_select === true, "listed in the main section with quick select, like Anthropic's current models");
  ok(flash.capabilities && flash.capabilities.mm_images === true && flash.capabilities.mm_pdf === false &&
     flash.capabilities.web_search === true, "capabilities: images from vision, no pdf, web search on");
  ok(pro.capabilities.web_search === false, "webSearch:false reaches the picker's capabilities");
  ok(flash.thinking.type === "effort" && flash.thinking.effort_options.map((o) => o.id).join(",") === "low,medium,high,xhigh,max",
     "thinking is type effort with the five levels (no ultracode)");
  const three = JSON.parse(JSON.stringify(cfg));
  three.providers[0].models[0].effort = ["low", "high", "max"]; delete three.providers[0].models[0].effortDefault;
  const b3 = api.enrichBootstrap(bootstrap(), three).model_selector_config.find((s) => s.id === "ccd").models[3];
  ok(b3.thinking.effort_options.map((o) => o.id).join(",") === "low,high,max" && b3.thinking.effort_options[2].recommended === true &&
     b3.thinking.effort_options[2].name === "Max", "a three-level model offers exactly those, the highest as the (localised) default");
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
     flash1m.description === "1M context window", "context1m:true (first-release spelling) = both: adds the [1m] twin in upstream's 3p shape");
  ok(cfg.providers[0].models[0].context === "both" && cfg.providers[0].models[1].context === "200k" &&
     cfg.providers[0].context === "200k", "context: both from context1m, 200k when nothing says otherwise");
  // "1m": the model is listed under its [1m] spelling only - the only id the
  // CLI reads as a 1M window - and under its plain name.
  const one = JSON.parse(JSON.stringify(cfg));
  one.providers[0].models[0].context = "1m";
  const c1 = api.enrichBootstrap(bootstrap(), one).model_selector_config.find((s) => s.id === "ccd").models;
  ok(c1.length === 5 && c1[3].id === "claude-deepseek-flash[1m]" && c1[3].name === "DeepSeek Flash" &&
     !("supports_1m_context" in c1[3]) && c1[3].description === "V4.1 Flash" && c1[4].id === "claude-deepseek-pro",
     "context 1m: one entry, claude-<id>[1m], plain name, no 1M suffix flag: " + c1.map((e) => e.id).join(","));
  ok(JSON.stringify(api.listedIds(one.providers[0].models[0])) === '["claude-deepseek-flash[1m]"]' &&
     JSON.stringify(api.listedIds(cfg.providers[0].models[0])) === '["claude-deepseek-flash","claude-deepseek-flash[1m]"]' &&
     JSON.stringify(api.listedIds(cfg.providers[0].models[1])) === '["claude-deepseek-pro"]', "listedIds follows the context mode");
  ok(pro.id === "claude-deepseek-pro" && pro.thinking.type === "none" && pro.capabilities.mm_images === false &&
     pro.badge && pro.badge.message === "slow", "thinking:false is type none; vision:false drops images; badge is neutral");
  ok(JSON.stringify(out.model_selector_state) === JSON.stringify(bootstrap().model_selector_state) &&
     JSON.stringify(out.claude_ai_available_models) === JSON.stringify(bootstrap().claude_ai_available_models),
     "model_selector_state and claude_ai_available_models are not touched");
  ok(api.enrichBootstrap(out, cfg) === null, "a second pass finds every entry present and changes nothing");
  ok(api.enrichBootstrap({ account: {} }, cfg) === null, "a response without model_selector_config is left alone");
  api.rememberServerState(bootstrap(), cfg);
  const cr = await h["cdb-cm:config-read"](okSenderEv);
  ok(cr.anthropicModels.map((m) => m.id).join(",") === "claude-opus-5,claude-haiku-4-5-20251001,claude-opus-4-8",
     "the Anthropic models of the ccd surface are remembered for the web-search select: " + cr.anthropicModels.map((m) => m.id).join(","));
  const bad = await h["cdb-cm:websearch-set"](okSenderEv, "claude-nope-9");
  ok(bad.ok === false && /not one of the Anthropic models/.test(bad.error), "an Anthropic id the picker does not list is refused once a bootstrap was seen");

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
  switchOn(dir);
  const { api } = load(dir, { BUN_OPTIONS: "--smol" });
  const env = api.cliEnv();
  const preloadPath = join(dir, "custom-models", "preload.js");
  ok(env.BUN_OPTIONS === "--smol --preload=" + preloadPath,
     "BUN_OPTIONS appends our preload to the app's own value: " + env.BUN_OPTIONS);
  ok(existsSync(preloadPath) && readFileSync(preloadPath, "utf8") === PRELOAD_STUB,
     "the preload is written under <userData>/custom-models/");
  ok(env.CDB_CUSTOM_MODELS_LOG === join(dir, "logs", "custom-models.log"), "the CLI log lands in <userData>/logs/");
  const payload = JSON.parse(env.CDB_CUSTOM_MODELS_JSON);
  ok(payload.providers.length === 1 && !("apiKey" in payload.providers[0]) && !env.CDB_CUSTOM_MODELS_JSON.includes("sk-test-1234567890") &&
     payload.providers[0].baseUrl === "https://api.deepseek.com/anthropic" && payload.webSearch === "claude-deepseek-flash",
     "the env payload carries the endpoint and the app-wide web-search route (resolved from the legacy per-provider key), never the key");
  ok(payload.providers[0].models.length === 2 && payload.providers[0].models[1].thinking === false,
     "the payload carries the per-model routing flags");
  ok(!("name" in payload.providers[0].models[0]), "picker-only fields stay out of the CLI payload");
  writeFileSync(preloadPath, "stale");
  api.cliEnv();
  ok(readFileSync(preloadPath, "utf8") === PRELOAD_STUB, "a stale preload is rewritten");
  const { api: api2 } = load(dir, {});
  ok(api2.cliEnv().BUN_OPTIONS === "--preload=" + preloadPath, "no prior BUN_OPTIONS: ours alone");
  ok(!("CDB_CUSTOM_MODELS_DEBUG" in env) && !("CDB_CUSTOM_MODELS_DEBUG" in api2.cliEnv()), "no debug switch in the CLI env by default");
  const { api: api3 } = load(dir, { CDB_CUSTOM_MODELS_DEBUG: "1" });
  ok(api3.cliEnv().CDB_CUSTOM_MODELS_DEBUG === "1", "CDB_CUSTOM_MODELS_DEBUG=1 on the app is passed to the CLI (the preload traces its passthroughs)");
  // Live routing: the routes file the open sessions re-read.
  const routesPath = join(dir, "custom-models", "routes.json");
  ok(env.CDB_CUSTOM_MODELS_ROUTES === routesPath, "the CLI is told where the routes file is");
  ok(existsSync(routesPath) && (statSync(routesPath).mode & 0o777) === 0o600, "routes.json exists, 0600");
  const onDisk = JSON.parse(readFileSync(routesPath, "utf8"));
  ok(onDisk.providers[0].apiKey === "sk-test-1234567890" &&
     JSON.stringify(Object.assign({}, onDisk, { providers: onDisk.providers.map((p) => { const q = Object.assign({}, p); delete q.apiKey; return q; }) })) === JSON.stringify(payload),
     "and holds the env payload plus the keys - the one place the CLI gets them");
  rmSync(dir, { recursive: true, force: true });
}

// --- live routing: every change rewrites routes.json ------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  switchOn(dir);
  const { h, api } = load(dir);
  const routesPath = join(dir, "custom-models", "routes.json");
  const routes = () => JSON.parse(readFileSync(routesPath, "utf8"));
  let r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-secret-1234567890", preset: "deepseek" });
  ok(r.ok === true && existsSync(routesPath) && routes().providers.length === 0, "a provider without a model: routes.json written, empty (nothing routable yet)");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash" });
  ok(r.ok === true && routes().providers.length === 1 && routes().providers[0].apiKey === "sk-secret-1234567890" &&
     routes().providers[0].models[0].id === "deepseek-flash", "adding a model rewrites it with the provider, its key and the model");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-secret-0987654321" });
  ok(r.ok === true && routes().providers[0].apiKey === "sk-secret-0987654321", "a replaced key reaches routes.json at once");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === true && routes().webSearch === "claude-deepseek-flash", "so does the web-search target");
  r = await h["cdb-cm:pref-set"](okSenderEv, false);
  ok(r.ok === true && routes().providers.length === 0 && !("webSearch" in routes()), "switched off: the file is emptied, open sessions stop routing");
  r = await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(r.ok === true && routes().providers.length === 1, "switched on: back");
  r = await h["cdb-cm:model-delete"](okSenderEv, "ds", "deepseek-flash");
  ok(r.ok === true && routes().providers.length === 0, "the last model removed: empty again");
  const before = statSync(routesPath).mtimeMs;
  api.syncRoutes();
  ok(statSync(routesPath).mtimeMs === before, "an unchanged configuration does not rewrite the file (no needless mtime bump)");
  // A hand edit (the .jsonc, or secrets.json written by another tool) is
  // watched: routes.json follows within the debounce.
  await new Promise((r) => setTimeout(r, 30)); // the deferred install sets the watches
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  await new Promise((r) => setTimeout(r, 700));
  ok(routes().providers.length === 1 && routes().providers[0].id === "deepseek" && routes().providers[0].apiKey === "sk-test-1234567890",
     "a hand-written .jsonc provider reaches routes.json without the panel: " + JSON.stringify(routes().providers.map((p) => p.id)));
  rmSync(dir, { recursive: true, force: true });
}

// --- CDP Fetch flow -----------------------------------------------------------
function fakeWc(url) {
  const sent = [];
  const listeners = {};
  const dbgListeners = {};
  const wc = {
    getURL: () => url,
    isDestroyed: () => false,
    on: (ev, fn) => { listeners[ev] = fn; },
    debugger: {
      attached: 0,
      detached: 0,
      listenerCalls: 0,
      attach: function () { this.attached++; },
      isAttached: function () { return this.attached > this.detached; },
      detach: function () { this.detached++; if (dbgListeners.detach) dbgListeners.detach({}, "target closed"); },
      on: function (ev, fn) { this.listenerCalls++; dbgListeners[ev] = fn; },
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
  switchOn(dir);
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
  ok(!!enable && enable.params.patterns.every((p) => p.requestStage === "Response" && /(api|edge-api)\/bootstrap|model_selector_state/.test(p.urlPattern)),
     "Fetch.enable pauses only bootstrap and model-selection responses");
  ok(!!enable && enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/edge-api/bootstrap/*/app_start*") &&
     enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/api/bootstrap/*/app_start*") &&
     enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/api/bootstrap"),
     "both the /api and the /edge-api spellings of app_start (and the bare endpoint) are covered");
  ok(!!enable && !enable.params.patterns.some((p) => /bootstrap\/\*\/(system_prompts|current_user_access)/.test(p.urlPattern)) &&
     enable.params.patterns.some((p) => p.urlPattern === "*://claude.ai/api/organizations/*/model_selector_state/*"),
     "the other bootstrap sub-resources are not paused; the model-selection writes are");

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
  switchOn(dir);
  const { h, sandbox, api } = load(dir);
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

  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic/", apiKey: "sk-secret-1234567890", preset: "deepseek" });
  ok(r.ok === true && r.providers.length === 1 && r.providers[0].id === "ds" && r.providers[0].keyOk === true && r.providers[0].keySource === "stored",
     "provider-set adds the provider with a stored key");
  ok(r.providers[0].preset === "deepseek" && r.providers[0].effort.join(",") === "low,high,max",
     "the preset is kept on the provider and gives it its effort levels");
  ok(r.presets.some((x) => x.id === "kimi") && r.presets.some((x) => x.id === "glm") && !r.presets.some((x) => Array.isArray(x.models)),
     "presets know endpoints, not model lists");
  ok(r.webSearch === "" && r.webSearchLocked === false, "web search defaults to Anthropic");
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
    thinking: true, vision: true, context: "1m", effortDefault: "xhigh" });
  ok(r.ok === true && r.configured === true && r.providers[0].models.length === 1 && r.providers[0].models[0].alias === "claude-deepseek-flash",
     "model-set adds the model and the provider becomes usable");
  const j2 = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(JSON.stringify(j2.customModels.providers[0].models[0]) === JSON.stringify({ id: "deepseek-flash", name: "DeepSeek Flash" }),
     "defaults (thinking, vision, xhigh, the preset's 1M context) are not written out: " + JSON.stringify(j2.customModels.providers[0].models[0]));
  // The DeepSeek preset knows its models are 1M: inherited, listed as [1m].
  ok(r.providers[0].context === "1m" && r.providers[0].models[0].context === "1m" &&
     JSON.stringify(r.providers[0].models[0].listedAs) === '["claude-deepseek-flash[1m]"]',
     "the model inherits the preset's 1M context and is listed as claude-deepseek-flash[1m]");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "DeepSeek Flash", context: "200k", effortDefault: "xhigh" });
  ok(r.ok === true && r.providers[0].models[0].context === "200k" &&
     JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[0].context === "200k",
     "a context that differs from the provider's is written");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "DeepSeek Flash", context: "1m", effortDefault: "xhigh" });
  ok(r.ok === true && !("context" in JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[0]),
     "back to the provider's value, the key is dropped again");
  // Effort levels live on the provider: the preset gave low/high/max, the
  // model inherits them and its default is the highest.
  ok(r.providers[0].effort.join(",") === "low,high,max" && r.providers[0].models[0].effort.join(",") === "low,high,max" &&
     r.providers[0].models[0].effortDefault === "max", "the model inherits the provider's (preset) effort levels, default max");
  ok(JSON.stringify(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[0]) ===
     JSON.stringify({ id: "deepseek-flash", name: "DeepSeek Flash" }),
     "neither the inherited levels nor the automatic default are written on the model");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "Flash", effortDefault: "high" });
  ok(r.ok === true && r.providers[0].models[0].effortDefault === "high" &&
     JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[0].effortDefault === "high",
     "a default that differs from the automatic one is written");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "Flash", effortDefault: "xhigh" });
  ok(r.ok === true && r.providers[0].models[0].effortDefault === "max", "a default outside the provider's levels falls back");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "", effort: ["low", "max"] });
  ok(r.ok === true && r.providers[0].effort.join(",") === "low,max" && r.providers[0].models[0].effort.join(",") === "low,max",
     "provider-set changes the levels for every model of the provider");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].effort.join(",") === "low,max",
     "and writes them on the provider");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "", effort: [] });
  ok(r.ok === false && /at least one/.test(r.error), "an empty level list is refused");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "", effort: ["low", "high", "max"] });
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "Flash", thinking: false, vision: false, effortDefault: "high" });
  ok(r.ok === true && r.providers[0].models.length === 1 && r.providers[0].models[0].name === "Flash" && r.providers[0].models[0].thinking === false,
     "model-set on an existing id updates in place");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "bad id" });
  ok(r.ok === false && /model id/.test(r.error), "a bad model id is refused");
  r = await h["cdb-cm:model-set"](okSenderEv, "nope", { id: "x" });
  ok(r.ok === false && /not in/.test(r.error), "a model for an unknown provider is refused");

  // Editing the provider without a key keeps the stored one; the enabled
  // switch now works since a model exists.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "" });
  ok(r.ok === true && r.providers[0].keyOk === true && r.providers[0].keySource === "stored",
     "an empty key field keeps the stored key");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "nope");
  ok(r.ok === false && /neither/.test(r.error), "web search only accepts a configured model or an Anthropic id");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "claude-opus-5");
  ok(r.ok === true && r.webSearch === "claude-opus-5" && JSON.parse(api.cliEnv().CDB_CUSTOM_MODELS_JSON).webSearch === "claude-opus-5",
     "an Anthropic id is accepted as the web-search target and handed to the CLI");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "nosearch", webSearch: false });
  ok(r.ok === true && r.providers[0].models[1].webSearch === false, "a model can be marked without the web search tool");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "nosearch");
  ok(r.ok === false && /without the web search tool/.test(r.error), "and is then refused as the web-search target");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[1].webSearch === false,
     "webSearch:false is written out");
  await h["cdb-cm:model-delete"](okSenderEv, "ds", "nosearch");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === true && r.webSearch === "claude-deepseek-flash", "websearch-set stores the alias");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.webSearch === "claude-deepseek-flash",
     "as customModels.webSearch in the .json");
  ok(JSON.parse(api.cliEnv().CDB_CUSTOM_MODELS_JSON).webSearch === "claude-deepseek-flash", "and hands it to the CLI");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "");
  ok(r.ok === true && r.webSearch === "" && !("webSearch" in JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels),
     "an empty value goes back to Anthropic and drops the key");

  // The small/fast slot: ANTHROPIC_SMALL_FAST_MODEL. Unlike webSearch, no tool
  // restriction - a model marked webSearch:false still qualifies, since the
  // slot covers WebFetch and the mid-turn classifier, not web search.
  ok(r.smallFastModel === "" && r.smallFastModelLocked === false, "the small/fast slot defaults to Anthropic");
  ok(!("ANTHROPIC_SMALL_FAST_MODEL" in api.cliEnv()), "and is absent from the CLI env when unset");
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "nope");
  ok(r.ok === false && /neither/.test(r.error), "the small/fast slot only accepts a configured model or an Anthropic id");
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "claude-opus-5");
  ok(r.ok === true && r.smallFastModel === "claude-opus-5" && api.cliEnv().ANTHROPIC_SMALL_FAST_MODEL === "claude-opus-5",
     "an Anthropic id is accepted as the small/fast model and lands in the CLI env");
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === true && r.smallFastModel === "claude-deepseek-flash", "a custom alias is resolved and stored");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.smallFastModel === "claude-deepseek-flash",
     "as customModels.smallFastModel in the .json");
  ok(api.cliEnv().ANTHROPIC_SMALL_FAST_MODEL === "claude-deepseek-flash", "and is injected as ANTHROPIC_SMALL_FAST_MODEL in the CLI env");
  // A model marked without the web search tool is allowed for the slot (it is
  // not web search): the tool restriction is webSearch's, not the slot's.
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "nosearch", webSearch: false });
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "nosearch");
  ok(r.ok === true && r.smallFastModel === "claude-nosearch", "a model without the web search tool is accepted for the small/fast slot");
  await h["cdb-cm:model-delete"](okSenderEv, "ds", "nosearch");
  // The [1m] twin is stripped: the small/fast slot runs the base id.
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "deepseek-flash[1m]");
  ok(r.ok === true && r.smallFastModel === "claude-deepseek-flash", "the [1m] twin is resolved to the base alias");
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "");
  ok(r.ok === true && r.smallFastModel === "" && !("smallFastModel" in JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels),
     "an empty value goes back to Anthropic and drops the key");

  r = await h["cdb-cm:pref-set"](okSenderEv, false);
  ok(r.ok === true && r.enabled === false, "the switch works once a model exists");
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers.length === 1,
     "flipping the switch keeps the providers");

  // The provider's model list: preset URL first, then the generic candidates;
  // both response shapes understood.
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = (url) => Promise.resolve(url === "https://api.deepseek.com/v1/models"
    ? new Response(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }, { id: "bad id" }] }), { status: 200 })
    : new Response("{}", { status: 404 }));
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === true && r.source === "https://api.deepseek.com/v1/models" && r.models.map((m) => m.id).join(",") === "deepseek-flash,deepseek-v4-pro",
     "models-list asks the preset's URL first and keeps only plain ids: " + JSON.stringify(r));
  ok(sandbox.__fetchCalls[0].init.method === "GET" && sandbox.__fetchCalls[0].init.headers.authorization === "Bearer sk-secret-1234567890" &&
     sandbox.__fetchCalls[0].init.headers["x-api-key"] === "sk-secret-1234567890", "with the key as Bearer and x-api-key");
  // OpenRouter's shape: name is a display name, context_length settles the context mode.
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ data: [
    { id: "qwen/qwen3.8-max-0902", name: "Qwen: Qwen3.8 Max", context_length: 1000000 },
    { id: "z-ai/glm-5.3", name: "Z.ai: GLM 5.3", context_length: 1310720 },
    { id: "inference-net/small", name: "Small", context_length: 128000 },
    { id: "~z-ai/glm-latest", name: "alias", context_length: 1310720 }] }), { status: 200 }));
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === true && r.models.length === 3 && r.models[0].id === "qwen/qwen3.8-max-0902" && r.models[0].name === "Qwen: Qwen3.8 Max" &&
     r.models[0].context === "1m" && r.models[1].context === "1m" && r.models[2].context === "200k",
     "an OpenRouter listing: name as display name, 1m from a context_length of 1M+, aliases with ~ dropped: " + JSON.stringify(r.models));
  ok(!("anthropic-version" in sandbox.__fetchCalls[0].init.headers), "the first try carries no anthropic-version - it flips OpenRouter into its paginated Anthropic shape");
  // The Anthropic Models API shape: 20 per page, has_more/last_id, ?after_id= - every page is fetched.
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = (url) => {
    const after = /after_id=([^&]+)/.exec(url);
    const page = after ? (after[1] === "b" ? 2 : 3) : 1;
    const body = page === 1 ? { data: [{ id: "a" }, { id: "b" }], has_more: true, first_id: "a", last_id: "b" }
      : page === 2 ? { data: [{ id: "c" }, { id: "b" }], has_more: true, first_id: "c", last_id: "d" }
      : { data: [{ id: "e" }], has_more: false, first_id: "e", last_id: "e" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === true && r.models.map((m) => m.id).join(",") === "a,b,c,e" && sandbox.__fetchCalls.length === 3 &&
     /after_id=b$/.test(sandbox.__fetchCalls[1].url) && /after_id=d$/.test(sandbox.__fetchCalls[2].url),
     "a paginated (has_more/last_id) listing is followed page by page, duplicates dropped: " + JSON.stringify(r.models.map((m) => m.id)) + " " + sandbox.__fetchCalls.map((c) => c.url).join(" "));
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = (url) => Promise.resolve(url === "https://api.deepseek.com/models"
    ? new Response(JSON.stringify({ data: [{ id: "m1", display_name: "Model One" }] }), { status: 200 })
    : new Response("nope", { status: 404 }));
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === true && r.source === "https://api.deepseek.com/models" && r.models[0].name === "Model One" &&
     sandbox.__fetchCalls.map((c) => c.url).join(" ") === "https://api.deepseek.com/v1/models https://api.deepseek.com/v1/models https://api.deepseek.com/anthropic/v1/models https://api.deepseek.com/anthropic/v1/models https://api.deepseek.com/models" &&
     !("anthropic-version" in sandbox.__fetchCalls[0].init.headers) && sandbox.__fetchCalls[1].init.headers["anthropic-version"] === "2023-06-01",
     "falls through the candidates in order, each tried without then with anthropic-version and reads display_name: " + sandbox.__fetchCalls.map((c) => c.url).join(" "));
  sandbox.__fetchImpl = () => Promise.resolve(new Response("nope", { status: 404 }));
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === false && /no model list found/.test(r.error) && /HTTP 404/.test(r.error), "every candidate failing is reported with the attempts");
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ id: "msg" }), { status: 200 }));

  // The connectivity test: one token to the first model with the stored key.
  sandbox.__fetchCalls.length = 0;
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

  // The effort probe: one token per level, the provider's verdicts collected.
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = (url, init) => {
    const lv = JSON.parse(init.body).output_config.effort;
    return Promise.resolve(lv === "medium" || lv === "xhigh"
      ? new Response(JSON.stringify({ error: { message: "invalid reasoning_effort: " + lv } }), { status: 400 })
      : new Response("{}", { status: 200 }));
  };
  r = await h["cdb-cm:effort-probe"](okSenderEv, "ds", "");
  ok(r.ok === true && r.accepted.join(",") === "low,high,max" && Object.keys(r.rejected).join(",") === "medium,xhigh",
     "effort-probe (first model of the provider) reports the accepted levels and the refused ones: " + JSON.stringify(r));
  ok(sandbox.__fetchCalls.length === 5 && sandbox.__fetchCalls.every((c) => { const b = JSON.parse(c.init.body);
       return b.thinking.type === "enabled" && b.thinking.budget_tokens >= 1024 && b.thinking.budget_tokens < b.max_tokens && b.max_tokens <= 1025; }),
     "five minimal requests with thinking on, each valid for a strict endpoint (1024 <= budget < max_tokens)");
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }));
  r = await h["cdb-cm:effort-probe"](okSenderEv, "ds", "deepseek-flash");
  ok(r.ok === false && /invalid api key/.test(r.error), "every level refused for one reason reports that reason, not 'no level'");
  sandbox.__fetchImpl = () => Promise.resolve(new Response("{}", { status: 200 }));

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

// --- SECURITY: a stored key never follows its provider to another host --------
// The page (remote claude.ai code) can call every channel above. It must not
// be able to re-point a provider at its own server and have test, fetch
// models, detect or the next session send it the key.
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h, sandbox } = load(dir);
  const secretsPath = join(dir, "custom-models", "secrets.json");
  const routesPath = join(dir, "custom-models", "routes.json");
  const KEY = "sk-secret-1234567890";
  let r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: KEY, preset: "deepseek" });
  await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash" });
  await h["cdb-cm:pref-set"](okSenderEv, true);
  ok(JSON.parse(readFileSync(routesPath, "utf8")).providers[0].apiKey === KEY, "setup: the key is stored and routed");

  // Same host, other path: the key stays.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic/v2", apiKey: "", preset: "deepseek" });
  ok(r.ok === true && !r.keyCleared && r.providers[0].keyOk === true && JSON.parse(readFileSync(secretsPath, "utf8")).ds === KEY,
     "a base URL on the same host keeps the key");

  // Another host, no key given: the key is dropped everywhere.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://attacker.example/anthropic", apiKey: "", preset: "deepseek" });
  ok(r.ok === true && r.keyCleared === true && r.providers[0].keyOk === false, "moving the base URL to another host clears the key");
  ok(!("ds" in JSON.parse(readFileSync(secretsPath, "utf8"))), "the secret itself is deleted");
  const j = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(!("apiKeyStored" in j.customModels.providers[0]) && !("preset" in j.customModels.providers[0]),
     "the .json entry loses apiKeyStored, and the preset of the host it left");
  ok(!readFileSync(routesPath, "utf8").includes(KEY), "routes.json no longer carries the key");
  sandbox.__fetchCalls.length = 0;
  r = await h["cdb-cm:provider-test"](okSenderEv, "ds");
  ok(r.ok === false && /no API key/.test(r.error), "provider-test has no key to send");
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === false && /no API key/.test(r.error), "models-list has no key to send");
  r = await h["cdb-cm:effort-probe"](okSenderEv, "ds", "");
  ok(r.ok === false && /no API key/.test(r.error), "effort-probe has no key to send");
  ok(sandbox.__fetchCalls.length === 0, "nothing left the app");

  // Another host WITH a key typed in the same call: that key is kept.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890" });
  ok(r.ok === true && !r.keyCleared && r.providers[0].keyOk === true && JSON.parse(readFileSync(secretsPath, "utf8")).ds === "sk-gw-1234567890",
     "a key given with the new base URL is stored for it");

  // A models URL elsewhere is refused; the preset's is not tried off its host.
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://gw.example/anthropic", apiKey: "", modelsUrl: "https://attacker.example/v1/models" });
  ok(r.ok === false && /same host/.test(r.error), "a models URL on another host is refused");
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = () => Promise.resolve(new Response("nope", { status: 404 }));
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(sandbox.__fetchCalls.length > 0 && sandbox.__fetchCalls.every((c) => c.url.indexOf("https://gw.example/") === 0),
     "models-list only asks the base URL's host: " + sandbox.__fetchCalls.map((c) => c.url).join(" "));
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ id: "msg" }), { status: 200 }));

  // A key source a hand edit left in the .json does not follow either.
  const jj = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  jj.customModels.providers[0].apiKeyFile = join(dir, "hand.key");
  writeFileSync(join(dir, "hand.key"), "sk-hand-1234567890\n");
  writeFileSync(join(dir, "claude-desktop-extra.json"), JSON.stringify(jj));
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://attacker.example/anthropic", apiKey: "" });
  const jk = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8"));
  ok(r.keyCleared === true && !("apiKeyFile" in jk.customModels.providers[0]) && r.providers[0].keyOk === false,
     "an apiKeyFile in the .json is dropped when the host changes");

  // A new provider never inherits a secret left under its id.
  writeFileSync(secretsPath, JSON.stringify({ fresh: "sk-stale-1234567890" }));
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "fresh", baseUrl: "https://attacker.example/anthropic", apiKey: "" });
  ok(r.ok === true && !("fresh" in JSON.parse(readFileSync(secretsPath, "utf8"))), "a stale secret under a new provider's id is deleted");
  rmSync(dir, { recursive: true, force: true });
}

// --- what the preload needs to send effort and web search right -------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h } = load(dir);
  const routesPath = join(dir, "custom-models", "routes.json");
  await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-ds-1234567890", preset: "deepseek" });
  await h["cdb-cm:provider-set"](okSenderEv, { id: "gw", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890" });
  await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash" });
  await h["cdb-cm:model-set"](okSenderEv, "gw", { id: "gw-model", webSearch: false });
  await h["cdb-cm:pref-set"](okSenderEv, true);
  const routes = JSON.parse(readFileSync(routesPath, "utf8"));
  const ds = routes.providers.find((p) => p.id === "ds"), gw = routes.providers.find((p) => p.id === "gw");
  ok(JSON.stringify(ds.effort) === '["low","high","max"]' && !("effort" in gw),
     "routes carry a provider's explicit effort list (the preload sends those levels as they are), none for the default");
  let r = await h["cdb-cm:smallfast-set"](okSenderEv, "gw-model");
  ok(r.ok === true && /without the web search tool/.test(r.searchConflict),
     "a small/fast model without the web search tool, no web-search model: the panel is told searches would fail");
  r = await h["cdb-cm:websearch-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === true && r.searchConflict === "", "naming a web-search model clears the warning");

  // Saving a model in the panel keeps the file-only fields a hand edit added.
  const jp = join(dir, "claude-desktop-extra.json");
  const j = JSON.parse(readFileSync(jp, "utf8"));
  Object.assign(j.customModels.providers.find((p) => p.id === "ds").models[0], { effort: ["low", "max"], shortName: "Flash", section: "overflow", vision: false });
  writeFileSync(jp, JSON.stringify(j));
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "DeepSeek Flash" });
  const m = JSON.parse(readFileSync(jp, "utf8")).customModels.providers.find((p) => p.id === "ds").models[0];
  ok(r.ok === true && JSON.stringify(m.effort) === '["low","max"]' && m.shortName === "Flash" && m.section === "overflow",
     "model-set keeps the file-only fields (effort, shortName, section): " + JSON.stringify(m));
  ok(!("vision" in m) && m.name === "DeepSeek Flash", "and the fields the panel owns are its own (vision back on, the new name)");
  rmSync(dir, { recursive: true, force: true });
}

// --- review fixes: headers, dangling choices, write order, names, redirects ------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  switchOn(dir);
  const { h, api, sandbox, diag } = load(dir);
  const jp = join(dir, "claude-desktop-extra.json");
  const secretsPath = join(dir, "custom-models", "secrets.json");
  const routesPath = join(dir, "custom-models", "routes.json");
  await h["cdb-cm:provider-set"](okSenderEv, { id: "gw", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890" });
  await h["cdb-cm:model-set"](okSenderEv, "gw", { id: "gw-a" });
  await h["cdb-cm:model-set"](okSenderEv, "gw", { id: "gw-b", webSearch: false });

  // Custom headers (a gateway's auth header) do not follow the provider either.
  const j = JSON.parse(readFileSync(jp, "utf8"));
  j.customModels.providers[0].headers = { "cf-aig-authorization": "Bearer USER-SECRET", "bad header": "x" };
  writeFileSync(jp, JSON.stringify(j));
  ok(!("bad header" in api.readConfig().providers[0].headers) && diag.some((l) => /"bad header" is not a valid HTTP header/.test(l)),
     "a malformed header name is dropped from the config, and the log says so");
  let r = await h["cdb-cm:provider-set"](okSenderEv, { id: "gw", baseUrl: "https://evil.example/anthropic", apiKey: "sk-attacker-12345" });
  ok(r.ok === true && r.headersCleared === true && !r.keyCleared && !("headers" in JSON.parse(readFileSync(jp, "utf8")).customModels.providers[0]),
     "moving the base URL to another host drops the custom headers too (a key typed in the same save is kept)");
  sandbox.__fetchCalls.length = 0;
  await h["cdb-cm:provider-test"](okSenderEv, "gw");
  ok(sandbox.__fetchCalls.length === 1 && !("cf-aig-authorization" in sandbox.__fetchCalls[0].init.headers), "so provider-test sends the new host no header of the old one");
  await h["cdb-cm:provider-set"](okSenderEv, { id: "gw", baseUrl: "https://gw.example/anthropic", apiKey: "sk-gw-1234567890" });

  // A deleted model takes the app-wide choices that named it along.
  await h["cdb-cm:websearch-set"](okSenderEv, "gw-a");
  await h["cdb-cm:smallfast-set"](okSenderEv, "gw-a");
  await h["cdb-cm:subagent-set"](okSenderEv, "gw-a");
  r = await h["cdb-cm:model-delete"](okSenderEv, "gw", "gw-a");
  const cm = JSON.parse(readFileSync(jp, "utf8")).customModels;
  ok(r.webSearch === "" && r.smallFastModel === "" && r.subagentModel === "" && !("webSearch" in cm) && !("smallFastModel" in cm) && !("subagentModel" in cm),
     "deleting a model clears the web-search, small/fast and sub-agent choices that named it");
  ok(!("ANTHROPIC_SMALL_FAST_MODEL" in api.cliEnv()), "so no session is handed an id nothing routes");
  // A leftover custom alias no longer passes for an Anthropic id once the picker's list is known.
  api.rememberServerState(bootstrap(), api.readConfig());
  const j2 = JSON.parse(readFileSync(jp, "utf8")); j2.customModels.smallFastModel = "claude-gw-gone"; j2.customModels.webSearch = "claude-haiku-4-5-20251001";
  writeFileSync(jp, JSON.stringify(j2));
  const c2 = api.readConfig();
  ok(c2.smallFastModel === "" && c2.webSearch === "claude-haiku-4-5-20251001",
     "an unknown claude-* id is refused once the picker's Anthropic models are known; a listed one is kept");
  r = await h["cdb-cm:provider-delete"](okSenderEv, "gw");
  ok(r.ok === true, "provider-delete still works");

  // The key is not stored when the .json cannot be written, and the old one stays.
  await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-old-1234567890" });
  const good = readFileSync(jp, "utf8");
  writeFileSync(jp, "{ not json");
  r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://other.example/anthropic", apiKey: "sk-new-1234567890" });
  ok(r.ok === false && JSON.parse(readFileSync(secretsPath, "utf8")).ds === "sk-old-1234567890",
     "a .json that cannot be written leaves the stored key as it was");
  writeFileSync(jp, good);

  // A custom sub-agent name survives an unrelated edit in the panel.
  await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-chat", agentName: "ds-coder" });
  r = await h["cdb-cm:config-read"](okSenderEv);
  const mm = r.providers.find((p) => p.id === "ds").models[0];
  ok(mm.agentName === "ds-coder" && mm.agentDefaults.name === "deepseek-chat",
     "the panel gets the generated name as the default, so it pre-fills the custom one (and a save keeps it)");

  // routes.json deleted behind the app's back is written again.
  await h["cdb-cm:pref-set"](okSenderEv, true);
  rmSync(routesPath);
  api.syncRoutes();
  ok(existsSync(routesPath), "a deleted routes.json is written again on the next sync");

  // Redirects: followed on the provider's host, refused off it.
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = (url) => Promise.resolve(url === "https://api.deepseek.com/anthropic/v1/messages"
    ? new Response(null, { status: 307, headers: { location: "/anthropic/v2/messages" } })
    : new Response(JSON.stringify({ id: "msg" }), { status: 200 }));
  r = await h["cdb-cm:provider-test"](okSenderEv, "ds");
  ok(r.ok === true && sandbox.__fetchCalls.length === 2 && sandbox.__fetchCalls[1].url === "https://api.deepseek.com/anthropic/v2/messages" &&
     sandbox.__fetchCalls[0].init.redirect === "manual", "a redirect on the provider's host is followed");
  sandbox.__fetchCalls.length = 0;
  sandbox.__fetchImpl = () => Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }));
  r = await h["cdb-cm:provider-test"](okSenderEv, "ds");
  ok(r.ok === false && /redirected to https:\/\/evil\.example/.test(r.error) && sandbox.__fetchCalls.length === 1,
     "a redirect to another host is refused - the key is not sent there");
  r = await h["cdb-cm:models-list"](okSenderEv, "ds");
  ok(r.ok === false && sandbox.__fetchCalls.every((c) => !c.url.startsWith("https://evil.example")), "models-list does not follow it either");
  sandbox.__fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ id: "msg" }), { status: 200 }));

  // The web-search warning also covers a session running on a model without the tool.
  await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "no-tool", webSearch: false });
  r = await h["cdb-cm:websearch-set"](okSenderEv, "");
  ok(/no-tool is marked without the web search tool/.test(r.searchConflict), "any model without the tool, no web-search model: the panel warns");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Trailing commas are stripped outside strings only.
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), '{ "customModels": { "providers": [ { "id": "d", "baseUrl": "https://d.example",\n' +
    '  "apiKey": "sk-xxxxxxxxxx", "models": [ { "id": "m", "description": "fast, }] cheap", }, ], }, ], }, }');
  const { api } = load(dir);
  ok(api.readConfig().providers[0].models[0].description === "fast, }] cheap", "a description containing \", }\" survives the JSONC reader");
  rmSync(dir, { recursive: true, force: true });
}

// --- locked (.jsonc) providers coexist with .json ones -------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  switchOn(dir);
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
  ok(r.webSearch === "claude-deepseek-flash" && r.webSearchLocked === false,
     "a per-provider webSearch in the .jsonc is honoured as the app-wide value but does not lock the select");
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS.replace('"providers"', '"webSearch": "gw-model",\n    "providers"'));
  r = await h["cdb-cm:websearch-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === false && /claude-desktop-extra\.jsonc/.test(r.error), "a top-level webSearch in the .jsonc locks the select");
  ok(api.readConfig().webSearch === "claude-gw-model", "and wins");
  // Rewrite the .jsonc with smallFastModel instead of webSearch: the PROVIDERS
  // fixture still has its per-provider webSearch (deepseek-flash) and the deepseek
  // provider; the .json provider (gw, stored key) still sits next to it.
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS.replace('"providers"', '"smallFastModel": "gw-model",\n    "providers"'));
  r = await h["cdb-cm:smallfast-set"](okSenderEv, "deepseek-flash");
  ok(r.ok === false && /claude-desktop-extra\.jsonc/.test(r.error), "a top-level smallFastModel in the .jsonc locks the select");
  ok(api.readConfig().smallFastModel === "claude-gw-model", "and wins");
  ok(api.cliEnv().ANTHROPIC_SMALL_FAST_MODEL === "claude-gw-model", "and reaches the CLI env");
  const cfg = api.readConfig();
  ok(cfg.providers.length === 2 && cfg.providers[1].apiKey === "sk-gw-1234567890" && cfg.providers[1].keySource === "stored",
     "the routing config resolves the stored key of the .json provider");
  const env = api.cliEnv();
  const payload = JSON.parse(env.CDB_CUSTOM_MODELS_JSON);
  ok(payload.providers.length === 2 && !("apiKey" in payload.providers[1]) &&
     JSON.parse(readFileSync(join(dir, "custom-models", "routes.json"), "utf8")).providers[1].apiKey === "sk-gw-1234567890",
     "and hands it to the CLI through routes.json, not the environment");
  rmSync(dir, { recursive: true, force: true });
}


// --- off is a full retreat: no debugger, no directory, no watcher -----------------
{
  // A profile that never used the feature: the deferred install writes nothing.
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  load(dir);
  await settle();
  ok(!existsSync(join(dir, "custom-models")) && !existsSync(join(dir, "claude-desktop-extra.json")),
     "a profile that never used the feature gets no custom-models/ directory and no .json");
  rmSync(dir, { recursive: true, force: true });
}
{
  // Configured but never switched on: the page is not even paused.
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  const { h, on } = load(dir);
  const f = fakeWc("https://claude.ai/code");
  on["web-contents-created"]({}, f.wc);
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 0, "configured but off: no debugger on claude.ai");
  // Switched on: the next navigation (the panel's Reload button) attaches.
  await h["cdb-cm:pref-set"](okSenderEv, true);
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 1, "switched on: the next navigation attaches");
  ok((statSync(join(dir, "custom-models")).mode & 0o777) === 0o700, "custom-models/ is created 0700");
  // A detach (DevTools, a crash) and the next navigation: attached again,
  // but the listeners are not registered twice.
  f.wc.debugger.detach();
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 2 && f.wc.debugger.listenerCalls === 2,
     "a re-attach reuses the listeners (message + detach registered once): " + f.wc.debugger.listenerCalls);
  // Switched off: detached at once.
  await h["cdb-cm:pref-set"](okSenderEv, false);
  ok(f.wc.debugger.detached === 2 && !f.wc.debugger.isAttached(), "switched off: the debugger lets go of the page at once");
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  ok(f.wc.debugger.attached === 2, "and does not come back on the next navigation");
  rmSync(dir, { recursive: true, force: true });
}
{
  // A custom-models/ left 0755 by something else is brought back to 0700.
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  mkdirSync(join(dir, "custom-models"), { mode: 0o755 });
  chmodSync(join(dir, "custom-models"), 0o755);
  const { h } = load(dir);
  await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-secret-1234567890" });
  ok((statSync(join(dir, "custom-models")).mode & 0o777) === 0o700 &&
     (statSync(join(dir, "custom-models", "secrets.json")).mode & 0o777) === 0o600, "the key's directory is narrowed to 0700 before a key is written");
  rmSync(dir, { recursive: true, force: true });
}

// --- remembered selection: the page's PATCH and the next bootstrap ---------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), PROVIDERS);
  switchOn(dir);
  const { api, on } = load(dir);
  const cfg = api.readConfig();
  const serverState = { id: "code", model: "claude-opus-5", thinking: { type: "effort", effort: "high" },
    thinking_by_model: [{ id: "claude-opus-5", thinking: { type: "effort", effort: "high" } }] };
  api.rememberServerState({ model_selector_state: [serverState] });

  // Pure decisions, in the shapes captured from claude.ai on 2026-09-13.
  const REFUSED = 400;
  let out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-deepseek-flash", thinking: { type: "effort", effort: "max" } }), REFUSED, cfg, {});
  ok(out.choices && out.choices.code.model === "claude-deepseek-flash" && out.choices.code.thinking.effort === "max",
     "a refused PATCH for one of ours is remembered with its thinking");
  ok(out.reply && out.reply.id === "code" && out.reply.model === "claude-deepseek-flash" &&
     out.reply.thinking_by_model.length === 2 && out.reply.thinking_by_model[1].id === "claude-deepseek-flash" &&
     out.reply.thinking_by_model[0].id === "claude-opus-5", "and answered in the server's shape, keeping the other models' thinking");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-deepseek-flash" }), REFUSED, cfg, {});
  ok(out.choices.code.thinking && out.choices.code.thinking.effort === "xhigh", "no thinking in the request: the model's default effort is used");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-opus-4-8" }), REFUSED, cfg, { code: { model: "claude-deepseek-flash" } });
  ok(out.choices === null && out.reply === null, "a refused PATCH for an Anthropic model is not ours to answer");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-opus-5" }), 200, cfg, { code: { model: "claude-deepseek-flash" } });
  ok(out.choices && !("code" in out.choices) && out.reply === null, "an accepted PATCH drops the memory for that surface");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-opus-5" }), 200, cfg, {});
  ok(out.choices === null, "and changes nothing when there was none");
  // The page also PATCHes {thinking} alone (the effort menu) and {fast_mode}:
  // the server applies those to the model IT holds (Opus) and answers 200 -
  // that must not forget our model, and the thinking asked for is ours.
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ thinking: { type: "effort", effort: "low" } }), 200, cfg,
    { code: { model: "claude-deepseek-flash", thinking: { type: "effort", effort: "max" } } });
  ok(out.choices && out.choices.code.model === "claude-deepseek-flash" && out.choices.code.thinking.effort === "low",
     "an accepted PATCH without a model keeps the memory and takes the new thinking");
  ok(out.reply && out.reply.model === "claude-deepseek-flash" && out.reply.thinking.effort === "low" &&
     out.reply.thinking_by_model.some((e) => e.id === "claude-deepseek-flash" && e.thinking.effort === "low"),
     "and the page is answered with our state, not the server's");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ fast_mode: "off" }), 200, cfg, { code: { model: "claude-deepseek-flash", thinking: { type: "effort", effort: "max" } } });
  ok(out.choices && out.choices.code.thinking.effort === "max" && out.reply && out.reply.model === "claude-deepseek-flash",
     "a fast_mode write keeps the remembered thinking");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ thinking: { type: "effort", effort: "low" } }), 200, cfg, {});
  ok(out.choices === null && out.reply === null, "with no memory a model-less write is the server's business");
  out = api.selectionOutcome("code", "PATCH", JSON.stringify({ model: "claude-deepseek-flash[1m]" }), REFUSED, cfg, {});
  ok(out.choices && out.choices.code.model === "claude-deepseek-flash[1m]" && out.reply.model === "claude-deepseek-flash[1m]",
     "the [1m] spelling is one of ours too");
  out = api.selectionOutcome("code", "GET", "", 200, cfg, {});
  ok(out.choices === null && out.reply === null, "only PATCH is looked at");
  out = api.selectionOutcome("code", "PATCH", "not json", REFUSED, cfg, {});
  ok(out.choices === null && out.reply === null, "an unreadable body is left alone");

  // The next bootstrap carries the choice as the server would.
  const boot = bootstrap();
  boot.model_selector_state = [JSON.parse(JSON.stringify(serverState)), { id: "chat", model: "claude-opus-5" }];
  const enriched = api.enrichBootstrap(boot, cfg, { code: { model: "claude-deepseek-flash", thinking: { type: "effort", effort: "max" } } });
  const st = enriched.model_selector_state[0];
  ok(st.model === "claude-deepseek-flash" && st.thinking.effort === "max", "the code state now names our model and its effort");
  ok(st.thinking_by_model.length === 2 && st.thinking_by_model[1].id === "claude-deepseek-flash", "and lists it in thinking_by_model");
  ok(enriched.model_selector_state[1].model === "claude-opus-5", "other surfaces are untouched");
  const boot2 = bootstrap();
  boot2.model_selector_state = [JSON.parse(JSON.stringify(serverState))];
  const e2 = api.enrichBootstrap(boot2, cfg, { code: { model: "claude-gone" } });
  ok(e2.model_selector_state[0].model === "claude-opus-5", "a remembered model that is no longer configured is ignored");

  // Through the CDP flow: a refused PATCH is fulfilled, the store written, and
  // the following bootstrap replays it.
  const f = fakeWc("https://claude.ai/code");
  on["web-contents-created"]({}, f.wc);
  f.listeners["did-start-navigation"]({ url: "https://claude.ai/code", isMainFrame: true });
  f.sent.length = 0;
  f.wc.__body = { body: JSON.stringify({ error: { details: { error_code: "model_not_selectable" } } }), base64Encoded: false };
  f.dbgListeners.message({}, "Fetch.requestPaused", {
    requestId: "p1", responseStatusCode: 400, responseHeaders: [],
    request: { url: "https://claude.ai/api/organizations/org-1/model_selector_state/code", method: "PATCH",
      postData: JSON.stringify({ model: "claude-deepseek-flash", thinking: { type: "effort", effort: "max" } }) }
  });
  await settle();
  const ful = f.sent.find((s) => s.method === "Fetch.fulfillRequest");
  ok(!!ful && ful.params.requestId === "p1" && ful.params.responseCode === 200 &&
     JSON.parse(Buffer.from(ful.params.body, "base64").toString("utf8")).model === "claude-deepseek-flash",
     "the refused PATCH is answered 200 with our model");
  const stored = JSON.parse(readFileSync(join(dir, "custom-models", "selection.json"), "utf8"));
  ok(stored.code && stored.code.model === "claude-deepseek-flash", "the choice is written to custom-models/selection.json");
  f.sent.length = 0;
  const b3 = bootstrap();
  b3.model_selector_state = [JSON.parse(JSON.stringify(serverState))];
  f.wc.__body = { body: JSON.stringify(b3), base64Encoded: false };
  f.dbgListeners.message({}, "Fetch.requestPaused", { requestId: "b1", request: { url: "https://claude.ai/edge-api/bootstrap/org-1/app_start" },
    responseStatusCode: 200, responseHeaders: [] });
  await settle();
  const ful2 = f.sent.find((s) => s.method === "Fetch.fulfillRequest");
  const replayed = ful2 && JSON.parse(Buffer.from(ful2.params.body, "base64").toString("utf8"));
  ok(replayed && replayed.model_selector_state[0].model === "claude-deepseek-flash", "the next bootstrap replays the choice");
  f.sent.length = 0;
  f.wc.__body = { body: JSON.stringify({ id: "code", model: "claude-opus-5", thinking_by_model: [] }), base64Encoded: false };
  f.dbgListeners.message({}, "Fetch.requestPaused", {
    requestId: "p2", responseStatusCode: 200, responseHeaders: [],
    request: { url: "https://claude.ai/api/organizations/org-1/model_selector_state/code", method: "PATCH", postData: JSON.stringify({ model: "claude-opus-5" }) }
  });
  await settle();
  ok(f.sent.some((s) => s.method === "Fetch.continueRequest" && s.params.requestId === "p2") && !f.sent.some((s) => s.method === "Fetch.fulfillRequest"),
     "an accepted PATCH passes through untouched");
  ok(!("code" in JSON.parse(readFileSync(join(dir, "custom-models", "selection.json"), "utf8"))), "and forgets our choice for that surface");
  rmSync(dir, { recursive: true, force: true });
}

// --- sub-agent types and the system-prompt line ----------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), JSON.stringify({ customModels: { providers: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890", models: [
      { id: "deepseek-flash", name: "DeepSeek Flash", context: "1m" },
      { id: "deepseek-pro", name: "DeepSeek Pro", context: "both", agent: { name: "Bad Name!", description: "Judge-free fan-out on Pro" } },
      { id: "quiet", agent: false }
    ] },
    { id: "gw", baseUrl: "http://127.0.0.1:8787", apiKey: "sk-test-1234567890", models: [
      { id: "gemini-3.8-flash" },
      { id: "flash2", name: "DeepSeek Flash" },
      { id: "x", name: "Explore", agent: { prompt: "Tu es Explore sur X." } }
    ] }
  ] } }));
  switchOn(dir);
  const { api, diag } = load(dir);
  const cfg = api.readConfig();
  const names = {};
  cfg.providers.forEach((p) => p.models.forEach((m) => { names[p.id + "/" + m.id] = m.agent ? m.agentName : null; }));
  ok(names["deepseek/deepseek-flash"] === "deepseek-flash", "a type is named from the display name, slugged: " + names["deepseek/deepseek-flash"]);
  ok(names["gw/gemini-3.8-flash"] === "gemini-3-8-flash", "dots and the like become dashes: " + names["gw/gemini-3.8-flash"]);
  ok(names["deepseek/deepseek-pro"] === "deepseek-pro", "an invalid configured name falls back to the generated one: " + names["deepseek/deepseek-pro"]);
  await new Promise((r) => setTimeout(r, 5));
  ok(diag.some((l) => /agent\.name "bad name!"/.test(l)), "and says so once");
  ok(names["deepseek/quiet"] === null, "agent: false means no type");
  ok(names["gw/flash2"] === "deepseek-flash-gw", "a display name already taken gets the provider id: " + names["gw/flash2"]);
  ok(names["gw/x"] === "explore-gw", "a built-in type's name is never shadowed: " + names["gw/x"]);

  const defs = api.agents(undefined, LOCAL);
  ok(defs && Object.keys(defs).sort().join(",") === "deepseek-flash,deepseek-flash-gw,deepseek-pro,explore-gw,gemini-3-8-flash",
     "agents(): one definition per model with a type: " + Object.keys(defs || {}).join(","));
  ok(defs["deepseek-flash"].model === "claude-deepseek-flash[1m]" && defs["gemini-3-8-flash"].model === "claude-gemini-3.8-flash",
     "a definition runs the model under its listed id");
  ok(defs["deepseek-pro"].model === "claude-deepseek-pro[1m]", "a model listed twice (both) runs its agent on the 1M twin");
  ok(/^Sub-agent running on DeepSeek Flash via deepseek/.test(defs["deepseek-flash"].description) &&
     /^You are a sub-agent running on DeepSeek Flash, a custom model served by deepseek/.test(defs["deepseek-flash"].prompt),
     "the generated description and prompt name the model and the provider");
  ok(defs["deepseek-pro"].description === "Judge-free fan-out on Pro" && /^You are a sub-agent/.test(defs["deepseek-pro"].prompt),
     "a configured description is used as is, the prompt stays generated");
  ok(defs["explore-gw"].prompt === "Tu es Explore sur X." && /^Sub-agent running on Explore via gw/.test(defs["explore-gw"].description),
     "and the reverse");
  ok(!("tools" in defs["deepseek-flash"]), "no tool restriction: the type inherits the session's tools");
  const theirs = { "deepseek-flash": { description: "the app's own", prompt: "p" }, other: { description: "o", prompt: "q" } };
  const merged = api.agents(theirs, LOCAL);
  ok(merged !== theirs && merged["deepseek-flash"].description === "the app's own" && merged.other && merged["gemini-3-8-flash"],
     "the app's own definitions are kept and win a name clash");
  ok(api.agents("nonsense", LOCAL) === "nonsense" && api.agents([1], LOCAL).length === 1, "an unexpected shape from the app is left alone");

  const line = api.appendSystemPrompt(undefined, LOCAL);
  ok(typeof line === "string" && /^Custom models available in this app \(claude-desktop-extra\)/.test(line), "appendSystemPrompt(): the line, alone when the app has none");
  ok(/claude-deepseek-flash\[1m\] \(DeepSeek Flash, deepseek; sub-agent type deepseek-flash\)/.test(line) &&
     /claude-deepseek-pro and claude-deepseek-pro\[1m\] \(DeepSeek Pro, deepseek; sub-agent type deepseek-pro\)/.test(line) &&
     /claude-quiet \(quiet, deepseek\)[;.]/.test(line), "it lists every id with its name, provider and type (none for quiet): " + line);
  ok(/subagent_type/.test(line) && /agentType: "<type>"/.test(line) && /not valid values for the Agent tool's `model` parameter/.test(line),
     "and says how to launch one, and where the ids are refused");
  ok(!/Sub-agents launched without a model/.test(line), "no sub-agent default: not mentioned");
  ok(api.appendSystemPrompt("The app's suffix.", LOCAL) === "The app's suffix.\n\n" + line, "appended after the app's own suffix");
  ok(api.appendSystemPrompt("  ", LOCAL) === line, "a blank suffix is replaced");
  const arr = api.appendSystemPrompt(["a", "b"], LOCAL);
  ok(Array.isArray(arr) && arr.length === 3 && arr[2] === line, "an array suffix gets one more entry");
  ok(!("CLAUDE_CODE_SUBAGENT_MODEL" in api.cliEnv()), "no sub-agent default: the CLI env is silent about it");

  // The default sub-agent model and the announce switch through the panel.
  const { h, api: api2 } = load(dir);
  let r = await h["cdb-cm:subagent-set"](okSenderEv, "nope");
  ok(r.ok === false && /not a configured custom model/.test(r.error), "subagent-set refuses an unknown model");
  r = await h["cdb-cm:subagent-set"](okSenderEv, "deepseek-flash[1m]");
  ok(r.ok === true && r.subagentModel === "claude-deepseek-flash[1m]", "subagent-set resolves a bare id (even with [1m]) to the listed id: " + r.subagentModel);
  ok(JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.subagentModel === "claude-deepseek-flash",
     "and writes the alias");
  ok(api2.cliEnv().CLAUDE_CODE_SUBAGENT_MODEL === "claude-deepseek-flash[1m]", "the CLI env then carries CLAUDE_CODE_SUBAGENT_MODEL");
  ok(/Sub-agents launched without a model of their own run on claude-deepseek-flash\[1m\]\./.test(api2.appendSystemPrompt(undefined, LOCAL)),
     "and the line mentions it");
  r = await h["cdb-cm:subagent-set"](okSenderEv, "");
  ok(r.ok === true && r.subagentModel === "" && !("subagentModel" in (JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels || {})),
     "an empty value clears it");
  r = await h["cdb-cm:announce-set"](okSenderEv, "no");
  ok(r.ok === false, "announce-set wants a boolean");
  r = await h["cdb-cm:announce-set"](okSenderEv, false);
  ok(r.ok === true && r.announce === false && r.announceText === "", "announce off: reported, no text");
  ok(api2.appendSystemPrompt("keep", LOCAL) === "keep" && api2.appendSystemPrompt(undefined, LOCAL) === undefined, "and the suffix is left exactly as the app had it");
  ok(api2.agents(undefined, LOCAL)["deepseek-flash"], "the types are still defined - only the line is off");
  r = await h["cdb-cm:announce-set"](okSenderEv, true);
  ok(r.ok === true && r.announce === true && !("announce" in (JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels || {})),
     "announce on again is the default, so the key is dropped");
  const det = await h["cdb-cm:config-read"](okSenderEv);
  const pro = det.providers[0].models[1];
  ok(pro.agent === true && pro.agentName === "deepseek-pro" && pro.agentDescription === "Judge-free fan-out on Pro" && pro.agentPrompt === "" &&
     pro.agentDefaults.name === "deepseek-pro" && /^Sub-agent running on DeepSeek Pro/.test(pro.agentDefaults.description),
     "the panel sees the type, what is customised and the generated defaults");
  ok(det.providers[0].models[2].agent === false && det.providers[0].models[2].agentName === "", "and a model without a type");
  ok(typeof det.announceText === "string" && /^Custom models available/.test(det.announceText), "and the line itself");
  rmSync(dir, { recursive: true, force: true });
}

// --- only a session with the preload gets them; an SSH session loses cliEnv() --------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), JSON.stringify({ customModels: {
    enabled: true, subagentModel: "deepseek-flash", smallFastModel: "deepseek-flash", providers: [
      { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890", models: [{ id: "deepseek-flash" }] }] } }));
  const { api, diag } = load(dir, { BUN_OPTIONS: "--smol" });
  const cowork = { options: { env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" } } };
  ok(api.agents(undefined, cowork) === undefined && api.appendSystemPrompt("x", cowork) === "x",
     "a query from another env builder (Cowork, Dispatch, a helper) gets no type and no line");
  ok(api.agents(undefined, LOCAL)["deepseek-flash"], "a local Code session does");
  ok(api.agents(undefined, undefined) === undefined && api.appendSystemPrompt(undefined, undefined) === undefined, "no transport: nothing");
  ok(api.agents(undefined, {}) === undefined && api.agents(undefined, {}) === undefined &&
     diag.filter((l) => /transport has no options\.env/.test(l)).length === 1,
     "a transport without options.env (upstream moved it): nothing, said once in the log");

  const env = Object.assign({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "t" }, api.cliEnv());
  ok(env.CLAUDE_CODE_SUBAGENT_MODEL === "claude-deepseek-flash" && env.ANTHROPIC_SMALL_FAST_MODEL === "claude-deepseek-flash" &&
     /--smol --preload=.*custom-models\/preload\.js$/.test(env.BUN_OPTIONS), "setup: cliEnv() set the preload and both model slots");
  api.remoteSpawn({ env });
  ok(!("CDB_CUSTOM_MODELS_JSON" in env) && !("CDB_CUSTOM_MODELS_ROUTES" in env) && !("CDB_CUSTOM_MODELS_LOG" in env),
     "remoteSpawn() takes our variables out of an SSH session's env");
  ok(env.BUN_OPTIONS === "--smol", "keeps the app's own BUN_OPTIONS, without our preload");
  ok(!("CLAUDE_CODE_SUBAGENT_MODEL" in env) && !("ANTHROPIC_SMALL_FAST_MODEL" in env),
     "and the model slots it set, which the remote spawner forwards (CLAUDE_*/ANTHROPIC_*) to a host without the preload");
  ok(env.CLAUDE_CODE_OAUTH_TOKEN === "t" && env.PATH === "/usr/bin", "the rest of the session env is untouched");
  ok(api.agents(undefined, { options: { env } }) === undefined, "so sub-patch C hands that session no sub-agent type");

  // A slot the app had in its own environment is given back, not dropped.
  const { api: api2 } = load(dir, { ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-9" });
  const env2 = api2.cliEnv();
  api2.remoteSpawn({ env: env2 });
  ok(env2.ANTHROPIC_SMALL_FAST_MODEL === "claude-haiku-9" && !("BUN_OPTIONS" in env2), "a slot the app itself had is restored");
  // An env cliEnv() never fed is left alone.
  const plain = { BUN_OPTIONS: "--x", CLAUDE_CODE_SUBAGENT_MODEL: "claude-opus-5" };
  api.remoteSpawn({ env: plain });
  ok(plain.BUN_OPTIONS === "--x" && plain.CLAUDE_CODE_SUBAGENT_MODEL === "claude-opus-5", "an env without our marker is not touched");
  api.remoteSpawn(undefined);
  api.remoteSpawn({});
  ok(true, "a missing options object or env is survived");
  rmSync(dir, { recursive: true, force: true });
}

// --- cliEnv() builds on the env upstream is about to send -----------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), JSON.stringify({ customModels: {
    enabled: true, subagentModel: "deepseek-flash", providers: [
      { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890", models: [{ id: "deepseek-flash" }] }] } }));
  const { api } = load(dir, { BUN_OPTIONS: "--from-process-env" });
  // The user's Code-tab variables are in upstream's env, not in process.env.
  const base = { PATH: "/usr/bin", BUN_OPTIONS: "--user-set", CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-9" };
  const env = Object.assign({}, base, api.cliEnv(base));
  ok(/^--user-set --preload=.*custom-models\/preload\.js$/.test(env.BUN_OPTIONS) && env.CLAUDE_CODE_SUBAGENT_MODEL === "claude-deepseek-flash",
     "BUN_OPTIONS builds on the session's own value (the user's Code-tab setting), not the app's process.env: " + env.BUN_OPTIONS);
  api.remoteSpawn({ env });
  ok(env.BUN_OPTIONS === "--user-set" && env.CLAUDE_CODE_SUBAGENT_MODEL === "claude-sonnet-9",
     "an SSH session gets back exactly what upstream would have sent, the user's slot value included");
  rmSync(dir, { recursive: true, force: true });
}
{
  // BUN_OPTIONS is split on whitespace: a profile path with a space cannot carry the preload.
  const dir = mkdtempSync(join(tmpdir(), "cdb cm main "));
  writeFileSync(join(dir, "claude-desktop-extra.jsonc"), JSON.stringify({ customModels: { enabled: true, providers: [
    { id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890", models: [{ id: "deepseek-flash" }] }] } }));
  const { api, diag } = load(dir);
  ok(JSON.stringify(api.cliEnv()) === "{}" && diag.some((l) => /contains whitespace/.test(l)),
     "a profile path with whitespace: the session is left alone, and the log says why");
  rmSync(dir, { recursive: true, force: true });
}

// --- sub-agent fields through model-set ---------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-main-"));
  const { h } = load(dir);
  let r = await h["cdb-cm:provider-set"](okSenderEv, { id: "ds", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890" });
  ok(r.ok === true, "provider added");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-flash", name: "DeepSeek Flash", agent: true, agentName: "", agentDescription: "", agentPrompt: "" });
  ok(r.ok === true && r.providers[0].models[0].agentName === "deepseek-flash", "a model added with empty agent fields gets the generated type");
  let written = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[0];
  ok(!("agent" in written), "and nothing about it is written (the defaults are not stored)");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-pro", agent: true, agentName: "Fan-Out", agentDescription: "Fan-out only", agentPrompt: "Do the step." });
  ok(r.ok === true && r.providers[0].models[1].agentName === "fan-out", "a typed name is lowercased and used");
  written = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[1];
  ok(written.agent && written.agent.name === "fan-out" && written.agent.description === "Fan-out only" && written.agent.prompt === "Do the step.",
     "the customised texts are written under agent");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-x", agent: true, agentName: "fan-out" });
  ok(r.ok === false && /sub-agent name fan-out is already used by ds \/ deepseek-pro/.test(r.error), "a typed name already taken is refused: " + r.error);
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-x", agent: true, agentName: "general-purpose" });
  ok(r.ok === false && /built-in/.test(r.error), "a built-in type's name is refused");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-x", agent: true, agentName: "Not/ok" });
  ok(r.ok === false && /lowercase letters, digits and -/.test(r.error), "an invalid name is refused");
  r = await h["cdb-cm:model-set"](okSenderEv, "ds", { id: "deepseek-pro", agent: false });
  ok(r.ok === true && r.providers[0].models[1].agent === false && r.providers[0].models[1].agentName === "", "unticking the type");
  written = JSON.parse(readFileSync(join(dir, "claude-desktop-extra.json"), "utf8")).customModels.providers[0].models[1];
  ok(written.agent === false, "is written as agent: false");
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
