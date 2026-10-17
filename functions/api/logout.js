import { clearSessionCookie } from "../_lib/session.js";
import { json } from "../_lib/http.js";

export async function onRequestPost() {
  const response = json({ ok: true });
  response.headers.set("set-cookie", clearSessionCookie());
  return response;
}
