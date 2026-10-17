let googleTokenCache = { token: "", expMs: 0, fingerprint: "" };

function b64urlBytes(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlText(text) {
  return b64urlBytes(new TextEncoder().encode(text));
}

function pemToPkcs8(pem) {
  const b64 = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error("GOOGLE_CREDENTIALS has no usable private_key");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

function readCredentials(env) {
  let creds;
  try {
    creds = JSON.parse(env.GOOGLE_CREDENTIALS || "");
  } catch (_) {
    throw new Error("GOOGLE_CREDENTIALS is not valid JSON");
  }
  if (!creds.client_email || !creds.private_key) {
    throw new Error("GOOGLE_CREDENTIALS must contain client_email and private_key");
  }
  return creds;
}

export async function getGoogleAccessToken(env) {
  const creds = readCredentials(env);
  const fingerprint = `${creds.client_email}|${creds.private_key_id || ""}`;
  if (googleTokenCache.token && googleTokenCache.fingerprint === fingerprint && Date.now() < googleTokenCache.expMs - 60_000) {
    return googleTokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = creds.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64urlText(JSON.stringify(header))}.${b64urlText(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(creds.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${b64urlBytes(sig)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const r = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error(`Google service account token failed (${r.status}): ${d.error_description || d.error || "unknown error"}`);
  }
  googleTokenCache = {
    token: d.access_token,
    expMs: Date.now() + Math.max(300, Number(d.expires_in || 3600)) * 1000,
    fingerprint,
  };
  return d.access_token;
}

async function googleFetch(env, url, options = {}, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const token = await getGoogleAccessToken(env);
    const r = await fetch(url, {
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(options.headers || {}),
      },
    });
    if (r.ok) return r;
    const text = await r.text().catch(() => "");
    last = new Error(`Google Sheets API ${r.status}: ${text.slice(0, 240)}`);
    if (r.status !== 429 && r.status < 500) throw last;
    await new Promise(resolve => setTimeout(resolve, 450 * (2 ** i) + Math.floor(Math.random() * 250)));
  }
  throw last || new Error("Google Sheets API request failed");
}

export async function getValues(env, spreadsheetId, a1Range) {
  const sid = String(spreadsheetId || "").trim();
  if (!sid) throw new Error("Spreadsheet ID is not configured");
  const range = encodeURIComponent(a1Range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${range}?majorDimension=ROWS`;
  const r = await googleFetch(env, url);
  return r.json();
}

export async function batchGetValues(env, spreadsheetId, ranges) {
  const sid = String(spreadsheetId || "").trim();
  if (!sid) throw new Error("Spreadsheet ID is not configured");
  const qs = (ranges || []).map(r => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values:batchGet?majorDimension=ROWS&${qs}`;
  const r = await googleFetch(env, url);
  return r.json();
}

export async function appendValues(env, spreadsheetId, a1Range, rows) {
  const sid = String(spreadsheetId || "").trim();
  if (!sid) throw new Error("Spreadsheet ID is not configured");
  const range = encodeURIComponent(a1Range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sid)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const r = await googleFetch(env, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      majorDimension: "ROWS",
      values: rows,
    }),
  });
  return r.json();
}
