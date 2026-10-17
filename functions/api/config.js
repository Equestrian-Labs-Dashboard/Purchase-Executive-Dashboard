import { json } from "../_lib/http.js";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export async function onRequestGet(context) {
  const authRequired = enabled(context.env.AUTH_REQUIRED);
  const googleClientId = String(context.env.GOOGLE_CLIENT_ID || "").trim();
  return json({ ok: true, authRequired, googleClientId });
}
