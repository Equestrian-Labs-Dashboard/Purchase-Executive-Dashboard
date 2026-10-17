import { verifyGoogleIdToken } from "../_lib/google_identity.js";
import { createSessionToken, sessionCookie } from "../_lib/session.js";
import { getRegistryUser } from "../_lib/registry.js";
import { assertUserActive } from "../_lib/authz.js";
import { json, errorJson } from "../_lib/http.js";

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const credential = String(body?.credential || "").trim();
    if (!credential) return errorJson("Google credential is required", 400, "credential_missing");

    const identity = await verifyGoogleIdToken(credential, context.env);
    const user = assertUserActive(await getRegistryUser(context.env, identity.email));
    const { token, ttl } = await createSessionToken(context.env, user.email);

    const response = json({ ok: true, email: user.email, user: user.name });
    response.headers.set("set-cookie", sessionCookie(token, ttl));
    return response;
  } catch (e) {
    return errorJson(e?.message || "Sign in failed", Number(e?.status || 500), e?.code || "sign_in_failed");
  }
}
