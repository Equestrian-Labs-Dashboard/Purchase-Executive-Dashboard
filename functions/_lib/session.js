const COOKIE_NAME = "el_portal_session";

function b64urlBytes(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlText(text) {
  return b64urlBytes(new TextEncoder().encode(text));
}

function b64urlToBytes(value) {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return part.slice(idx + 1).trim();
  }
  return "";
}

async function hmacKey(env) {
  const secret = String(env.SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("SESSION_SECRET must be configured with at least 32 characters");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createSessionToken(env, email) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.min(7 * 24 * 3600, Math.max(900, Number(env.SESSION_TTL_SECONDS || 28800)));
  const payload = {
    v: 1,
    email: String(email || "").trim().toLowerCase(),
    iat: now,
    exp: now + ttl,
  };
  const body = b64urlText(JSON.stringify(payload));
  const key = await hmacKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return { token: `${body}.${b64urlBytes(sig)}`, ttl };
}

export async function verifySessionRequest(request, env) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) {
    const err = new Error("Sign in required");
    err.status = 401;
    err.code = "session_missing";
    throw err;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    const err = new Error("Invalid session");
    err.status = 401;
    err.code = "session_invalid";
    throw err;
  }
  let payload;
  try { payload = decodePart(parts[0]); }
  catch (_) {
    const err = new Error("Invalid session");
    err.status = 401;
    err.code = "session_invalid";
    throw err;
  }
  const key = await hmacKey(env);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64urlToBytes(parts[1]),
    new TextEncoder().encode(parts[0]),
  );
  const now = Math.floor(Date.now() / 1000);
  if (!ok || payload.v !== 1 || !payload.email || !payload.exp || Number(payload.exp) <= now) {
    const err = new Error(Number(payload?.exp || 0) <= now ? "Session expired" : "Invalid session");
    err.status = 401;
    err.code = Number(payload?.exp || 0) <= now ? "session_expired" : "session_invalid";
    throw err;
  }
  return { email: String(payload.email).trim().toLowerCase(), payload };
}

export function sessionCookie(token, ttl) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(ttl)}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
