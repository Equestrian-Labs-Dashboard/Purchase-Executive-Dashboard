import { verifySessionRequest } from "./session.js";
import { getRegistryUser } from "./registry.js";

export function assertUserActive(user) {
  if (!user) {
    const err = new Error("Your verified email is not registered for this portal");
    err.status = 403;
    err.code = "user_not_registered";
    throw err;
  }
  if (user.reportAccess.tokens.includes("blocked")) {
    const err = new Error("Access is disabled for this email");
    err.status = 403;
    err.code = "user_blocked";
    throw err;
  }
  if (!user.reportAccess.all && !user.reportAccess.tokens.length) {
    const err = new Error("No report access is configured for this email");
    err.status = 403;
    err.code = "no_report_access";
    throw err;
  }
  return user;
}

export async function authorize(context) {
  const identity = await verifySessionRequest(context.request, context.env);
  const user = assertUserActive(await getRegistryUser(context.env, identity.email));
  return { identity, user };
}
