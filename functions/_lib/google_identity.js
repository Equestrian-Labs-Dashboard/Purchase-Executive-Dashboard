let googleJwksCache = { ts: 0, keys: [] };

function b64urlToBytes(value) {
  const pad = "=".repeat((4 - (value.length % 4)) % 4);
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(value)));
}

async function getGoogleJwks(force = false) {
  if (!force && googleJwksCache.keys.length && Date.now() - googleJwksCache.ts < 60 * 60 * 1000) {
    return googleJwksCache.keys;
  }
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs", { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Could not load Google signing keys (${r.status})`);
  const d = await r.json();
  const keys = Array.isArray(d.keys) ? d.keys : [];
  if (!keys.length) throw new Error("Google returned no signing keys");
  googleJwksCache = { ts: Date.now(), keys };
  return keys;
}

function audMatches(payloadAud, expected) {
  if (Array.isArray(payloadAud)) return payloadAud.includes(expected);
  return String(payloadAud || "") === expected;
}

export async function verifyGoogleIdToken(token, env) {
  const expectedAud = String(env.GOOGLE_CLIENT_ID || "").trim();
  if (!expectedAud) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    const err = new Error("Invalid Google identity token"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  let header, payload;
  try { header = decodeJsonPart(parts[0]); payload = decodeJsonPart(parts[1]); }
  catch (_) {
    const err = new Error("Invalid Google identity token"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  if (header.alg !== "RS256" || !header.kid) {
    const err = new Error("Unsupported Google identity token"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  let keys = await getGoogleJwks(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await getGoogleJwks(true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) {
    const err = new Error("Google signing key not found"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  const now = Math.floor(Date.now() / 1000);
  const issuer = String(payload.iss || "");
  if (!ok || !["accounts.google.com", "https://accounts.google.com"].includes(issuer) || !audMatches(payload.aud, expectedAud) || !payload.exp || Number(payload.exp) <= now) {
    const err = new Error("Google identity verification failed"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  if (payload.nbf && Number(payload.nbf) > now + 30) {
    const err = new Error("Google identity token is not active yet"); err.status = 401; err.code = "google_token_invalid"; throw err;
  }
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email || payload.email_verified !== true) {
    const err = new Error("Google did not provide a verified email address"); err.status = 401; err.code = "google_email_unverified"; throw err;
  }
  return { email, payload };
}
