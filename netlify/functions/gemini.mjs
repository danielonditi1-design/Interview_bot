// Netlify Function (v2 / ESM). Thin, locked-down proxy to the Gemini API so the
// API key never reaches the browser.
//
//   GET  /api/gemini  -> { configured, accessCodeRequired, model }   (health check)
//   POST /api/gemini  -> forwards a generateContent request body to Gemini
//
// Env vars: GEMINI_API_KEY (required), APP_ACCESS_CODE (recommended), GEMINI_MODEL (optional)

import { createHash, timingSafeEqual } from "node:crypto";

const DEFAULT_MODEL = "gemini-3-flash-preview";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_BODY_BYTES = 5 * 1024 * 1024; // Netlify's sync limit is ~6 MB
const ALLOWED_BODY_KEYS = ["contents", "systemInstruction", "generationConfig"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Constant-time comparison (hash first so lengths always match).
function safeEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export default async (req) => {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const accessCode = process.env.APP_ACCESS_CODE || "";
  const rawModel = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const model = /^[a-zA-Z0-9._-]+$/.test(rawModel) ? rawModel : DEFAULT_MODEL;

  if (req.method === "GET") {
    return json({ configured: Boolean(apiKey), accessCodeRequired: Boolean(accessCode), model });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (accessCode && !safeEqual(req.headers.get("x-access-code") || "", accessCode)) {
    return json({ error: "Invalid or missing access code." }, 401);
  }
  if (!apiKey) {
    return json({ error: "GEMINI_API_KEY is not set on the server." }, 500);
  }

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413);

  let incoming;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413);
    incoming = JSON.parse(raw);
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !incoming.contents) {
    return json({ error: "Missing 'contents' in request body." }, 400);
  }

  // Only forward known-safe fields (no tools, no safety overrides, no model switching).
  const body = {};
  for (const key of ALLOWED_BODY_KEYS) {
    if (incoming[key] !== undefined) body[key] = incoming[key];
  }

  let upstream;
  try {
    upstream = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return json({ error: `Could not reach Gemini: ${err?.message || err}` }, 502);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/gemini" };
