import { authorize } from "./_lib/authz.js";
import { queueAccessLog } from "./_lib/audit.js";
import { canUseReport } from "./_lib/registry.js";

const REPORT_KEY = "purchase_executive";
const PROJECT_NAME = "Purchase Executive Dashboard";

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
}
function accessDeniedResponse() {
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access denied</title></head><body style="font-family:Inter,Arial,sans-serif;text-align:center;padding:60px;background:#0b1c2b;color:#f4f8ff"><h1>Access denied</h1><p style="color:#7fa4c7">You don't have permission to view Purchase Executive Dashboard.</p><p style="color:#7fa4c7">Please request access through the Equestrian Labs Dashboard portal.</p></body></html>`, {status:403, headers:{"Content-Type":"text/html; charset=utf-8"}});
}
function setupErrorResponse(error) {
  const message = htmlEscape(error?.message || "Access configuration failed");
  return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access setup error</title></head><body style="font-family:Inter,Arial,sans-serif;text-align:center;padding:60px;background:#0b1c2b;color:#f4f8ff"><h1>Access setup error</h1><p style="color:#7fa4c7">Purchase Executive Dashboard could not validate the user registry.</p><pre style="white-space:pre-wrap;text-align:left;max-width:860px;margin:24px auto;padding:16px;background:#10263b;border:1px solid #234768;border-radius:8px">${message}</pre></body></html>`, {status:500, headers:{"Content-Type":"text/html; charset=utf-8"}});
}
function signInResponse(message = "Please sign in to view Purchase Executive Dashboard.") {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Purchase Executive Dashboard Sign In</title><script src="https://accounts.google.com/gsi/client" async defer></script><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,Arial,sans-serif;background:#0b1c2b;color:#f4f8ff}main{width:min(440px,calc(100vw - 32px));background:#10263b;border:1px solid #234768;border-radius:12px;padding:34px;box-shadow:0 18px 50px rgba(0,0,0,.25);text-align:center}h1{margin:0 0 10px;font-size:28px}p{margin:0 0 24px;color:#7fa4c7;line-height:1.5}#status{margin-top:16px;font-size:13px;color:#ff6678;min-height:18px}</style></head><body><main><h1>Purchase Executive Dashboard</h1><p>${htmlEscape(message)}</p><div id="googleBtn"></div><div id="status"></div><p style="font-size:12px;margin-top:22px">Use the Google account authorized in the Equestrian Labs portal.</p></main><script>const statusEl=document.getElementById("status");function setStatus(t){statusEl.textContent=t||""}async function init(){try{const cfgRes=await fetch("/api/config",{cache:"no-store"});const cfg=await cfgRes.json();if(!cfgRes.ok||!cfg.googleClientId)throw new Error(cfg.error||"Google sign-in is not configured");google.accounts.id.initialize({client_id:cfg.googleClientId,callback:async({credential})=>{try{setStatus("Signing in...");const r=await fetch("/api/login",{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({credential})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Sign-in failed");location.reload()}catch(err){setStatus(err.message||"Sign-in failed")}}});google.accounts.id.renderButton(document.getElementById("googleBtn"),{theme:"outline",size:"large",width:300})}catch(err){setStatus(err.message||"Unable to initialize sign-in")}}window.onload=init</script></body></html>`, {status:401, headers:{"Content-Type":"text/html; charset=utf-8"}});
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const protectedPath = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/index" || url.pathname.startsWith("/data/");
  if (!protectedPath || !enabled(context.env.AUTH_REQUIRED)) return context.next();

  try {
    const { user } = await authorize(context);
    if (!canUseReport(user, REPORT_KEY)) {
      queueAccessLog(context, { project: PROJECT_NAME, reportKey: REPORT_KEY, action: "view", result: "denied", user });
      return accessDeniedResponse();
    }
    queueAccessLog(context, { project: PROJECT_NAME, reportKey: REPORT_KEY, action: "view", result: "allowed", user });
    return context.next();
  } catch (e) {
    if (["session_missing", "session_expired", "session_invalid"].includes(e?.code)) {
      queueAccessLog(context, { project: PROJECT_NAME, reportKey: REPORT_KEY, action: "view", result: e.code });
      return signInResponse(e.code === "session_expired" ? "Your session expired. Please sign in again." : undefined);
    }
    if (!e?.status || Number(e.status) >= 500) {
      queueAccessLog(context, { project: PROJECT_NAME, reportKey: REPORT_KEY, action: "view", result: "setup_error" });
      return setupErrorResponse(e);
    }
    queueAccessLog(context, { project: PROJECT_NAME, reportKey: REPORT_KEY, action: "view", result: "denied" });
    return accessDeniedResponse();
  }
}
