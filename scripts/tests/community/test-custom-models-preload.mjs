#!/usr/bin/env node
/*
 * test-custom-models-preload.mjs - the Claude Code CLI half of the custom
 * models feature. js/custom_models_preload.js runs inside the Claude Code
 * binary (Bun); here it runs under Node with CDB_CUSTOM_MODELS_SELFTEST=1,
 * which skips the Bun/execPath gates and exports its internals. Every check
 * is about what leaves the process: which URL, which headers, which body.
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import Module from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n); } };

const CONFIG = {
  webSearch: "claude-deepseek-flash",
  providers: [{
    id: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", apiKey: "sk-test-1234567890",
    models: [{ id: "deepseek-flash", vision: true, thinking: true }, { id: "deepseek-pro", vision: false, thinking: false }]
  }, {
    id: "nokey", baseUrl: "https://gw.example/anthropic", apiKey: "",
    models: [{ id: "gw-model", vision: true, thinking: true }]
  }]
};

// Loads the preload with a recording fetch; returns its exported internals,
// the recorded calls and the sandbox env (to check the scrub).
function load(cfg, opts) {
  const calls = [];
  const responses = (opts && opts.responses) || [];
  const rawFetch = function (input, init) {
    calls.push({ url: typeof input === "string" ? input : input.href, init });
    const r = responses.shift();
    return Promise.resolve(r || new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  };
  rawFetch.preconnect = function () {};
  const env = Object.assign({
    CDB_CUSTOM_MODELS_SELFTEST: "1",
    CDB_CUSTOM_MODELS_JSON: cfg === null ? undefined : JSON.stringify(cfg),
    BUN_OPTIONS: "--smol --preload=/home/u/.config/Claude/custom-models/preload.js",
    PATH: "/usr/bin"
  }, (opts && opts.env) || {});
  Object.keys(env).forEach((k) => { if (env[k] === undefined) delete env[k]; });
  const sandbox = {
    require: (m) => Module.createRequire(import.meta.url)(m),
    process: { env, pid: 4242, execPath: "/usr/bin/node" },
    fetch: rawFetch, Response, Headers, URL, Buffer, console
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(readFileSync(join(ROOT, "js/custom_models_preload.js"), "utf8"), vm.createContext(sandbox));
  return { api: sandbox.__cdbCustomModelsPreload, hooked: sandbox.fetch, rawFetch, calls, env };
}

function messagesInit(body, extra) {
  return Object.assign({
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "context-1m-2025-08-07",
      "authorization": "Bearer sk-ant-oauth-secret", "x-api-key": "should-not-leak" },
    body: JSON.stringify(body)
  }, extra || {});
}
const ANTHROPIC = "https://api.anthropic.com/v1/messages";

// --- environment scrub --------------------------------------------------------
{
  const { api, env } = load(CONFIG);
  ok(!!api, "exports its internals under selftest");
  ok(!("CDB_CUSTOM_MODELS_JSON" in env), "the provider config (with the key) is deleted from process.env");
  ok(!("CDB_CUSTOM_MODELS_LOG" in env), "the log path is deleted from process.env");
  ok(env.BUN_OPTIONS === "--smol", "only our --preload token is stripped from BUN_OPTIONS: " + env.BUN_OPTIONS);
  ok(env.PATH === "/usr/bin", "other variables are untouched");
  const { env: env2 } = load(CONFIG, { env: { BUN_OPTIONS: "--preload=/home/u/.config/Claude/custom-models/preload.js" } });
  ok(!("BUN_OPTIONS" in env2), "BUN_OPTIONS is removed entirely when ours was its only content");
}

// --- no config / no match -> passthrough ---------------------------------------
{
  const { api, hooked, rawFetch } = load(null);
  ok(api === undefined && hooked === rawFetch, "no config: fetch is not hooked at all");
}
{
  const { api, hooked, rawFetch, calls } = load(CONFIG);
  ok(hooked !== rawFetch && typeof hooked.preconnect === "function", "fetch is replaced and keeps its static members");
  ok(api.routes.size === 3 && api.routes.has("claude-deepseek-flash") && api.routes.has("claude-gw-model"),
     "routes are keyed by the claude- alias");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }));
  ok(calls.length === 1 && calls[0].url === ANTHROPIC, "a Claude model goes to Anthropic untouched");
  ok(calls[0].init.headers.authorization === "Bearer sk-ant-oauth-secret", "its headers are the original object");
  await hooked("https://api.anthropic.com/v1/oauth/token", { method: "POST", body: "{}" });
  ok(calls.length === 2 && calls[1].url.endsWith("/oauth/token"), "non-messages endpoints pass through");
  await hooked("https://api.anthropic.com/v1/messages", { method: "GET" });
  ok(calls.length === 3, "a request without a string body passes through");
}

// --- a routed request: URL, headers, body --------------------------------------
{
  const { hooked, calls } = load(CONFIG);
  const body = {
    model: "claude-deepseek-flash[1m]", max_tokens: 32000, stream: true, temperature: 1,
    system: [{ type: "text", text: "You are Claude.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Read", input: { path: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file" }], cache_control: { type: "ephemeral" } }] },
      { role: "system", content: "effort changed" },
      { role: "user", content: "and now?" }
    ],
    tools: [{ name: "Read", description: "reads", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      { type: "web_search_20250305", name: "web_search" }, { type: "mcp_toolset", name: "x" }],
    tool_choice: { type: "auto" },
    thinking: { type: "enabled", budget_tokens: 31999 },
    output_config: { effort: "xhigh" },
    metadata: { user_id: "u" }, context_management: { edits: [] }, top_k: 5
  };
  const res = await hooked(ANTHROPIC, messagesInit(body));
  ok(calls.length === 1 && calls[0].url === "https://api.deepseek.com/anthropic/v1/messages",
     "a custom model is sent to the provider's /v1/messages: " + (calls[0] && calls[0].url));
  const h = calls[0].init.headers;
  ok(h instanceof Headers && h.get("x-api-key") === "sk-test-1234567890", "x-api-key is the provider key");
  ok(!h.has("authorization") && !h.has("anthropic-beta"), "the OAuth Authorization and beta headers do not leave");
  ok(h.get("anthropic-version") === "2023-06-01" && h.get("content-type") === "application/json", "version and content-type are kept");
  const out = JSON.parse(calls[0].init.body);
  ok(out.model === "deepseek-flash", "the [1m] suffix and the claude- prefix are removed for the provider");
  ok(out.max_tokens === 32000 && out.stream === true && out.temperature === 1, "plain parameters are forwarded");
  ok(!("metadata" in out) && !("context_management" in out) && !("top_k" in out), "Anthropic-only fields are dropped");
  ok(Array.isArray(out.system) && out.system.length === 1 && !("cache_control" in out.system[0]), "system blocks lose cache_control");
  ok(out.messages.length === 3, "user, assistant, then tool_result + folded system + user text merge into one user turn (" + out.messages.length + ")");
  ok(out.messages[0].content[1].type === "image", "images pass for a vision model");
  ok(out.messages[1].content[0].type === "thinking", "thinking blocks are kept on the first attempt");
  ok(out.messages[2].content.length === 3 && out.messages[2].content[1].text === "[system] effort changed" &&
     out.messages[2].content[2].text === "and now?", "a mid-conversation system message is folded as [system] user text");
  ok(!("cache_control" in out.messages[2].content[0]), "tool_result loses cache_control");
  ok(out.tools.length === 2 && out.tools[0].name === "Read" && !("cache_control" in out.tools[0]) &&
     out.tools[1].type === "web_search_20250305", "tools keep the schema ones and the web_search one, drop the rest");
  ok(out.tool_choice && out.tool_choice.type === "auto", "tool_choice is forwarded");
  ok(out.thinking.type === "enabled" && out.thinking.budget_tokens === 16000, "thinking budget is clamped to 16000");
  ok(out.output_config && out.output_config.effort === "max", "xhigh maps to max by default");
  ok(res && res.status === 200, "the provider's response is returned as is");
}

// --- thinking off, no-vision model, effort map, headers -------------------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].effortMap = { xhigh: "high" };
  cfg.providers[0].headers = { "x-extra": "1" };
  const { hooked, calls } = load(cfg);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "user", content: "x" }], thinking: { type: "disabled" }, output_config: { effort: "xhigh" } }));
  let out = JSON.parse(calls[0].init.body);
  ok(out.thinking.type === "disabled" && !("output_config" in out), "mode Off: thinking disabled and no effort travels with it");
  ok(calls[0].init.headers.get("x-extra") === "1", "provider headers are added");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "user", content: "x" }], output_config: { effort: "xhigh" } }));
  out = JSON.parse(calls[1].init.body);
  ok(out.output_config.effort === "high", "effortMap overrides the default mapping");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-pro", max_tokens: 100,
    messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "see" }] }],
    thinking: { type: "enabled", budget_tokens: 10 }, output_config: { effort: "max" } }));
  out = JSON.parse(calls[2].init.body);
  ok(out.thinking.type === "disabled" && !("output_config" in out), "thinking:false forces thinking off even when requested");
  ok(out.messages[0].content[0].type === "text" && /image omitted/.test(out.messages[0].content[0].text),
     "a no-vision model gets a placeholder instead of the image");
}

// --- count_tokens, missing key, unknown provider --------------------------------
{
  const { hooked, calls } = load(CONFIG);
  const c = await hooked("https://api.anthropic.com/v1/messages/count_tokens",
    messagesInit({ model: "claude-deepseek-flash", messages: [{ role: "user", content: "hello world" }] }));
  const cj = await c.json();
  ok(calls.length === 0 && typeof cj.input_tokens === "number" && cj.input_tokens > 0, "count_tokens is estimated locally, nothing leaves");
  const r = await hooked(ANTHROPIC, messagesInit({ model: "claude-gw-model", messages: [{ role: "user", content: "x" }] }));
  const rj = await r.json();
  ok(calls.length === 0 && r.status === 400 && rj.type === "error" && /no API key/.test(rj.error.message),
     "a provider without a key answers 400 (never 401 - the CLI would loop on OAuth refresh)");
}

// --- web search reroute ----------------------------------------------------------
{
  const { hooked, calls } = load(CONFIG);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "search" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }));
  ok(calls[0].url.startsWith("https://api.deepseek.com/") && JSON.parse(calls[0].init.body).model === "deepseek-flash",
     "the single-tool web_search sub-request is rerouted to the webSearch model");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "search" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }, { name: "Read", input_schema: {} }] }));
  ok(calls[1].url === ANTHROPIC, "a Claude conversation that merely lists web_search among other tools is not touched");
  // Legacy per-provider key still works when no app-wide value is given;
  // no route at all leaves web search on Anthropic.
  const legacy = JSON.parse(JSON.stringify(CONFIG)); delete legacy.webSearch; legacy.providers[0].webSearch = "deepseek-pro";
  const { hooked: h2, calls: c2 } = load(legacy);
  await h2(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(JSON.parse(c2[0].init.body).model === "deepseek-pro", "the per-provider webSearch is the fallback");
  // The target may be spelled with the [1m] suffix (a model listed as 1M).
  const oneM = JSON.parse(JSON.stringify(CONFIG)); oneM.webSearch = "claude-deepseek-flash[1m]";
  const { hooked: h1m, calls: c1m } = load(oneM);
  await h1m(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c1m[0].url.startsWith("https://api.deepseek.com/") && JSON.parse(c1m[0].init.body).model === "deepseek-flash",
     "a webSearch target spelled with [1m] finds its route");
  const none = JSON.parse(JSON.stringify(CONFIG)); delete none.webSearch;
  const { hooked: h3, calls: c3 } = load(none);
  await h3(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }] }));
  ok(c3[0].url === ANTHROPIC && JSON.parse(c3[0].init.body).model === "claude-haiku-4-5", "no web-search route: the sub-request stays as it is");
  // An Anthropic model as the target: same request to Anthropic, other model name.
  const opus = JSON.parse(JSON.stringify(CONFIG)); opus.webSearch = "claude-opus-5";
  const { hooked: h4, calls: c4 } = load(opus);
  await h4(ANTHROPIC, messagesInit({ model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content: "s" }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] }));
  const b4 = JSON.parse(c4[0].init.body);
  ok(c4[0].url === ANTHROPIC && b4.model === "claude-opus-5" && b4.tools[0].max_uses === 3 && c4[0].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "web search on Opus: only the model name changes, credentials and body untouched");
  await h4(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }));
  ok(JSON.parse(c4[1].init.body).model === "claude-opus-5" && c4[1].init.body === messagesInit({ model: "claude-opus-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }).body,
     "a normal Opus request is not rewritten");
}

// --- a foreign previous_message_id on the way to Anthropic ------------------------
{
  const { hooked, calls } = load(CONFIG);
  const mk = (id) => ({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    diagnostics: { previous_message_id: id }, metadata: { user_id: "u" } });
  await hooked(ANTHROPIC, messagesInit(mk("gen-1234567890abcdef")));
  let b = JSON.parse(calls[0].init.body);
  ok(calls[0].url === ANTHROPIC && b.diagnostics.previous_message_id === null && b.metadata.user_id === "u" && b.model === "claude-opus-5",
     "an id Anthropic did not mint (OpenRouter's gen-...) is sent as null, the rest untouched");
  await hooked(ANTHROPIC, messagesInit(mk("msg_01ABCDEF")));
  ok(calls[1].init.body === messagesInit(mk("msg_01ABCDEF")).body, "an Anthropic id passes through byte for byte");
  await hooked(ANTHROPIC, messagesInit({ model: "claude-opus-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }], diagnostics: { previous_message_id: null } }));
  ok(calls[2].init.body.indexOf('"previous_message_id":null') !== -1 && calls[2].init.headers.authorization === "Bearer sk-ant-oauth-secret",
     "null stays null and the original init (credentials) is kept");
}

// --- a provider 401: rewritten so the CLI does not chase its own OAuth token ---
{
  const responses = [new Response(JSON.stringify({ error: { message: "Authentication Fails, Your api key is invalid" } }),
    { status: 401, headers: { "content-type": "application/json" } })];
  const { hooked, calls } = load(CONFIG, { responses });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }));
  const body = await res.json();
  ok(calls.length === 1 && res.status === 400 && body.error.type === "authentication_error" &&
     /refused the API key \(HTTP 401\)/.test(body.error.message) && /api key is invalid/.test(body.error.message),
     "a provider 401 comes back as a 400 carrying the provider's message");
}

// --- a model without the web search tool ------------------------------------------
{
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  cfg.providers[0].models[0].webSearch = false;
  const { hooked, calls } = load(cfg);
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "x" }],
    tools: [{ name: "Read", input_schema: {} }, { type: "web_search_20250305", name: "web_search" }] }));
  const t = JSON.parse(calls[0].init.body).tools;
  ok(t.length === 1 && t[0].name === "Read", "webSearch:false strips the web_search tool from the model's requests");
}

// --- 400 on signed thinking -> retry without thinking blocks ----------------------
{
  const bad = new Response(JSON.stringify({ error: { message: "invalid thinking signature" } }), { status: 400 });
  const good = new Response("{}", { status: 200 });
  const { hooked, calls } = load(CONFIG, { responses: [bad, good] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text: "a" }] },
      { role: "user", content: "b" }] }));
  ok(calls.length === 2, "a 400 mentioning thinking/signature triggers exactly one retry");
  ok(JSON.parse(calls[0].init.body).messages[0].content.length === 2 &&
     JSON.parse(calls[1].init.body).messages[0].content.length === 1, "the retry drops the thinking blocks");
  ok(res.status === 200, "the retry's response is what the CLI gets");
  const other = new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [other] });
  const r2 = await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(c2.length === 1 && r2.status === 429, "other errors are returned without a retry");
}

// --- an effort level the provider does not know --------------------------------------
{
  const bad = new Response(JSON.stringify({ error: { message: "invalid reasoning_effort: xhigh" } }), { status: 400 });
  const good = new Response("{}", { status: 200 });
  const { hooked, calls } = load(CONFIG, { responses: [bad, good] });
  const res = await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100,
    messages: [{ role: "user", content: "b" }], output_config: { effort: "xhigh" } }));
  ok(calls.length === 2 && "output_config" in JSON.parse(calls[0].init.body) && !("output_config" in JSON.parse(calls[1].init.body)),
     "a 400 naming the effort is retried once without output_config");
  ok(JSON.parse(calls[1].init.body).thinking.type === "enabled", "thinking stays on for that retry");
  ok(res.status === 200, "and the retry's answer is what the CLI gets");
  const eff = new Response(JSON.stringify({ error: { message: "thinking options type cannot be disabled when reasoning_effort is set" } }), { status: 400 });
  const { hooked: h2, calls: c2 } = load(CONFIG, { responses: [eff] });
  await h2(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(c2.length === 1, "the thinking-disabled effort complaint is not mistaken for an unknown level");
}

// --- log file ----------------------------------------------------------------------
{
  const dir = mkdtempSync(join(tmpdir(), "cdb-cm-preload-"));
  const logPath = join(dir, "custom-models.log");
  const { hooked } = load(CONFIG, { env: { CDB_CUSTOM_MODELS_LOG: logPath } });
  await hooked(ANTHROPIC, messagesInit({ model: "claude-deepseek-flash", max_tokens: 100, messages: [{ role: "user", content: "b" }] }));
  ok(existsSync(logPath), "a log file is written at CDB_CUSTOM_MODELS_LOG");
  const text = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  ok(/active: claude-deepseek-flash -> deepseek\/deepseek-flash/.test(text), "the activation line lists the routes");
  ok(/-> deepseek\/deepseek-flash stream=false messages=1 tools=0/.test(text), "each routed request logs one line");
  ok(!/sk-test-1234567890/.test(text), "the key never appears in the log");
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
