import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import handler, { config } from "../netlify/functions/gemini.mjs";

const realFetch = globalThis.fetch;
const ENV_KEYS = ["GEMINI_API_KEY", "APP_ACCESS_CODE", "GEMINI_MODEL"];
let savedEnv;
let upstreamCalls;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  ENV_KEYS.forEach((k) => delete process.env[k]);
  upstreamCalls = [];
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  ENV_KEYS.forEach((k) => {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  });
});

const post = (body, headers = {}) =>
  new Request("http://localhost/api/gemini", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("is mounted at /api/gemini", () => {
  assert.equal(config.path, "/api/gemini");
});

test("GET reports configuration without leaking secrets", async () => {
  process.env.GEMINI_API_KEY = "secret-key";
  process.env.APP_ACCESS_CODE = "letmein";
  const res = await handler(new Request("http://localhost/api/gemini"));
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(data, { configured: true, accessCodeRequired: true, model: "gemini-3-flash-preview" });
  assert.ok(!JSON.stringify(data).includes("secret-key"));
  assert.ok(!JSON.stringify(data).includes("letmein"));
});

test("GET reports unconfigured when no key is set", async () => {
  const data = await (await handler(new Request("http://localhost/api/gemini"))).json();
  assert.equal(data.configured, false);
  assert.equal(data.accessCodeRequired, false);
});

test("rejects unsupported methods", async () => {
  const res = await handler(new Request("http://localhost/api/gemini", { method: "DELETE" }));
  assert.equal(res.status, 405);
});

test("POST without server key returns 500 with a clear message", async () => {
  const res = await handler(post({ contents: [] }));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /GEMINI_API_KEY/);
  assert.equal(upstreamCalls.length, 0);
});

test("access code is enforced when set", async () => {
  process.env.GEMINI_API_KEY = "k";
  process.env.APP_ACCESS_CODE = "letmein";
  const missing = await handler(post({ contents: [{}] }));
  const wrong = await handler(post({ contents: [{}] }, { "x-access-code": "nope" }));
  const right = await handler(post({ contents: [{}] }, { "x-access-code": "letmein" }));
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(right.status, 200);
  assert.equal(upstreamCalls.length, 1);
});

test("no access code configured means open proxy", async () => {
  process.env.GEMINI_API_KEY = "k";
  const res = await handler(post({ contents: [{}] }));
  assert.equal(res.status, 200);
});

test("forwards to the default model with the key in a header, never in the URL", async () => {
  process.env.GEMINI_API_KEY = "my-key";
  await handler(post({ contents: [{ parts: [{ text: "hi" }] }] }));
  const call = upstreamCalls[0];
  assert.equal(
    call.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
  );
  assert.equal(call.init.headers["x-goog-api-key"], "my-key");
  assert.ok(!call.url.includes("my-key"));
});

test("GEMINI_MODEL override is honoured; unsafe values fall back to default", async () => {
  process.env.GEMINI_API_KEY = "k";
  process.env.GEMINI_MODEL = "gemini-2.5-flash";
  await handler(post({ contents: [{}] }));
  assert.match(upstreamCalls[0].url, /models\/gemini-2\.5-flash:generateContent$/);

  process.env.GEMINI_MODEL = "../../evil?x=";
  await handler(post({ contents: [{}] }));
  assert.match(upstreamCalls[1].url, /models\/gemini-3-flash-preview:generateContent$/);
});

test("strips fields that are not on the allow-list", async () => {
  process.env.GEMINI_API_KEY = "k";
  await handler(
    post({
      contents: [{ parts: [{ text: "q" }] }],
      systemInstruction: { parts: [{ text: "sys" }] },
      generationConfig: { responseMimeType: "application/json" },
      tools: [{ googleSearch: {} }],
      safetySettings: [{ category: "x", threshold: "BLOCK_NONE" }],
      model: "something-else",
    })
  );
  const forwarded = JSON.parse(upstreamCalls[0].init.body);
  assert.deepEqual(Object.keys(forwarded).sort(), ["contents", "generationConfig", "systemInstruction"]);
});

test("validates body shape", async () => {
  process.env.GEMINI_API_KEY = "k";
  assert.equal((await handler(post("not json"))).status, 400);
  assert.equal((await handler(post({}))).status, 400);
  assert.equal((await handler(post([1, 2]))).status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test("rejects oversized bodies", async () => {
  process.env.GEMINI_API_KEY = "k";
  const big = JSON.stringify({ contents: [{ parts: [{ text: "x".repeat(5 * 1024 * 1024 + 10) }] }] });
  const res = await handler(post(big));
  assert.equal(res.status, 413);
});

test("passes Gemini error status and body through unchanged", async () => {
  process.env.GEMINI_API_KEY = "k";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), { status: 429 });
  const res = await handler(post({ contents: [{}] }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.message, "quota");
});

test("network failure to Gemini becomes a 502", async () => {
  process.env.GEMINI_API_KEY = "k";
  globalThis.fetch = async () => {
    throw new Error("boom");
  };
  const res = await handler(post({ contents: [{}] }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /boom/);
});
