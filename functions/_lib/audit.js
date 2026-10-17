import { appendValues } from "./google.js";

const DEFAULT_LOG_TAB = "Access Logs";

function safe(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "";
}

export async function logAccess(context, details) {
  const env = context.env || {};
  const spreadsheetId = String(env.ACCESS_LOG_SHEET_ID || env.USER_REGISTRY_SHEET_ID || "").trim();
  if (!spreadsheetId) return;

  const tab = String(env.ACCESS_LOG_TAB || DEFAULT_LOG_TAB).trim();
  const request = context.request;
  const url = new URL(request.url);
  const user = details.user || {};
  const cf = request.cf || {};

  const row = [
    new Date().toISOString(),
    safe(details.project || "Silo Ridge"),
    safe(details.reportKey || "silo_ridge"),
    safe(details.action || "view"),
    safe(details.result || "allowed"),
    safe(user.email || details.email || ""),
    safe(user.name || ""),
    safe(user.accessRaw || user.reportAccess?.raw || ""),
    safe(user.branchRaw || user.branchAccess?.raw || ""),
    safe(url.hostname),
    safe(url.pathname),
    safe(url.search),
    safe(clientIp(request)),
    safe(cf.country || ""),
    safe(request.headers.get("user-agent") || ""),
  ];

  try {
    await appendValues(env, spreadsheetId, `${tab}!A:O`, [row]);
  } catch (error) {
    console.warn("Access log write failed", error?.message || error);
  }
}

export function queueAccessLog(context, details) {
  const task = logAccess(context, details);
  if (context.waitUntil) context.waitUntil(task);
  return task.catch(() => {});
}
