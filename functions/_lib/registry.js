import { getValues } from "./google.js";

let registryCache = { key: "", ts: 0, users: new Map() };

const REPORT_ALIASES = {
  dashboard: ["dashboard", "main dashboard", "dashboard_corro", "dashboard cavali", "dashboard_cavali"],
  corro: ["corro", "dashboard_corro", "dashboard corro"],
  cavali: ["cavali", "cavalli", "dashboard_cavali", "dashboard cavali", "dashboard cavalli"],
  pareto: ["pareto", "pareto analysis", "gp"],
  frequency: ["frequency", "retention", "ret"],
  concierge: ["concierge", "concierge comm", "concierge comm.", "concierge commission", "concierge communication", "concierge communications"],
  monthly: ["monthly", "quarter", "weekly report", "monthly/q/weekly", "discounts", "monthly discounts", "nontlhy"],
  wellington: ["wellington", "commissions wellington"],
  hits: ["hits", "hit", "hudson"],
  upsell: ["upsell", "up sell", "smile", "saleschannel"],
  sales_reports: ["sales reports"],
  mud_fever: ["mud fever", "mud", "mudfever"],
  sku_savvy: ["sku savvy", "sku savy", "skusavvy", "skusavy", "sku", "operations"],
  financials_sales_channel: ["financials", "financial", "financial model", "financial model dashboard", "planning", "strategic operating model", "financials per sales channel", "financials sales channel", "returns", "returns report"],
  returns_report: ["returns", "returns report", "return report", "returns dashboard", "return dashboard", "shopify returns"],
  purchase_executive: ["purchase_executive", "purchase executive", "purchase executive dashboard", "purchasing"],
  inventory_by_month: ["inventory by month", "inventory", "inventory dashboard", "monthly inventory", "inventory by month dashboard", "inventory analytics"],
  sales_by_channel: ["sales by channel", "sales by channel summary", "channel sales"],
  smartrr: ["smartrr", "smart rr", "other sales channel", "other sales channels", "subscription report", "subscriptions"],
  yagya: ["yagya", "yaya"],
  athletics: ["athletics", "atletix", "athletix"],
  silo_ridge:[
 "silo ridge",
 "silo",
 "silo ridge performance",
 "silo ridge report"
],
};

function norm(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function cleanHeader(v) {
  return norm(v).replace(/[^a-z0-9]/g, "");
}
function splitAccess(raw) {
  return String(raw || "").split(/[;,|\/+]+|\s+and\s+|\s+y\s+/i).map(norm).filter(Boolean);
}

function uniqueTabs(tabs) {
  const seen = new Set();
  return tabs
    .map(tab => String(tab || "").trim())
    .filter(Boolean)
    .filter(tab => {
      const key = norm(tab);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function parseReportAccess(rawValue) {
  const raw = String(rawValue || "").trim();
  const low = norm(raw);
  if (!raw) return { raw, all: false, tokens: [] };
  if (["all", "todos", "todo", "all reports"].includes(low) || low.includes("all reports")) {
    return { raw, all: true, tokens: ["all"] };
  }
  const tokens = new Set();
  for (const part of splitAccess(raw)) {
    if (["all", "todos", "todo"].includes(part)) { tokens.add("all"); continue; }
    if (["no", "none", "deny", "denied", "blocked", "false"].includes(part)) { tokens.add("blocked"); continue; }
    for (const [key, aliases] of Object.entries(REPORT_ALIASES)) {
      if (aliases.some(a => part === a || part.includes(a))) tokens.add(key);
    }
  }
  if (tokens.has("all")) return { raw, all: true, tokens: ["all"] };
  return { raw, all: false, tokens: [...tokens] };
}

export function parseBranchAccess(rawValue) {
  const raw = String(rawValue || "").trim();
  const low = norm(raw);
  if (!raw || ["none", "no", "n/a", "na"].includes(low)) return { raw, all: false, tokens: [] };
  if (["all", "both", "todos", "todo", "corro + cavali", "corro+cavali", "corro, cavali", "corro,cavali"].includes(low)) {
    return { raw, all: true, tokens: ["all"] };
  }
  const tokens = new Set();
  for (const part of splitAccess(raw)) {
    if (["all", "both", "todos", "todo"].includes(part)) { tokens.add("all"); continue; }
    if (part.includes("corro")) tokens.add("corro");
    if (part.includes("cavali") || part.includes("cavalli")) tokens.add("cavali");
  }
  if (tokens.has("all")) return { raw, all: true, tokens: ["all"] };
  return { raw, all: false, tokens: [...tokens] };
}

export function hasReport(user, key) {
  const a = user?.reportAccess || { all: false, tokens: [] };
  if (a.tokens.includes("blocked")) return false;
  return a.all || a.tokens.includes(key);
}

export function canUseReport(user, key) {
  return hasReport(user, key);
}

export function hasBranch(user, brand) {
  const b = user?.branchAccess || { all: false, tokens: [] };
  return b.all || b.tokens.includes(brand);
}

export function canUseDashboardBrand(user, brand) {
  if (brand !== "corro" && brand !== "cavali") return false;
  const reportOk = hasReport(user, "dashboard") || hasReport(user, brand);
  return reportOk && hasBranch(user, brand);
}

export function canUseAnyDashboard(user) {
  return canUseDashboardBrand(user, "corro") || canUseDashboardBrand(user, "cavali");
}

function findHeaderIndexes(values) {
  for (let i = 0; i < Math.min(values.length, 15); i++) {
    const cleaned = (values[i] || []).map(cleanHeader);
    const email = cleaned.findIndex(h => ["email", "emailaddress", "useremail"].includes(h));
    const access = cleaned.findIndex(h => ["reportaccess", "access", "reports", "reportpermissions"].includes(h));
    if (email >= 0 && access >= 0) {
      return {
        row: i,
        name: cleaned.findIndex(h => ["username", "name", "user"].includes(h)),
        email,
        access,
        branch: cleaned.findIndex(h => ["branch", "brand", "branchaccess", "brandaccess"].includes(h)),
      };
    }
  }
  throw new Error("User Access Registry must contain Email and Report Access headers");
}

async function loadRegistry(env) {
  const spreadsheetId = String(env.USER_REGISTRY_SHEET_ID || "").trim();
  const configuredTab = String(env.USER_REGISTRY_TAB || "").trim();
  const tabsToTry = uniqueTabs([
    configuredTab,
    "Register Users",
    "User Access Registry",
    "Users",
    "Access",
  ]);
  if (!spreadsheetId) throw new Error("USER_REGISTRY_SHEET_ID is not configured");
  const cacheKey = `${spreadsheetId}|${tabsToTry.join(",")}`;
  const ttlMs = Math.max(5, Number(env.USER_REGISTRY_CACHE_SECONDS || 30)) * 1000;
  if (registryCache.key === cacheKey && Date.now() - registryCache.ts < ttlMs) return registryCache.users;

  let d;
  let loadedTab = "";
  const errors = [];
  for (const tab of tabsToTry) {
    try {
      const escapedTab = tab.replace(/'/g, "''");
      d = await getValues(env, spreadsheetId, `'${escapedTab}'!A:Z`);
      loadedTab = tab;
      break;
    } catch (e) {
      errors.push(`${tab}: ${e?.message || e}`);
    }
  }
  if (!d) {
    throw new Error(`User Access Registry tab could not be read. Tried: ${tabsToTry.join(", ")}. ${errors.join(" | ")}`);
  }
  const values = Array.isArray(d.values) ? d.values : [];
  if (!values.length) throw new Error(`User Access Registry tab "${loadedTab}" is empty or unreadable`);
  const idx = findHeaderIndexes(values);
  const users = new Map();

  for (const row of values.slice(idx.row + 1)) {
    const email = norm(row[idx.email]);
    if (!email || !email.includes("@")) continue;
    const name = idx.name >= 0 ? String(row[idx.name] || "").trim() : "";
    const accessRaw = String(row[idx.access] || "").trim();
    const branchRaw = idx.branch >= 0 ? String(row[idx.branch] || "").trim() : "";
    users.set(email, {
      email,
      name: name || email,
      accessRaw,
      branchRaw,
      reportAccess: parseReportAccess(accessRaw),
      branchAccess: parseBranchAccess(branchRaw),
    });
  }
  registryCache = { key: cacheKey, ts: Date.now(), users };
  return users;
}

export async function getRegistryUser(env, email) {
  const users = await loadRegistry(env);
  return users.get(norm(email)) || null;
}
