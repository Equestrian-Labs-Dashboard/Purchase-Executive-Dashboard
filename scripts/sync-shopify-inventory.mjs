import {readShopifyDailySales} from './shopify-sales-source.mjs';
import {readInventorySource} from './inventory-source.mjs';
import {normalizeReceiptData} from './normalize-receipt-data.mjs';
import fs from "node:fs/promises";
import path from "node:path";
import { parseVerifiedReceiptsCsv } from "./receipt-utils.mjs";
import { readShopifyRestockEvidence, readPurchaseOrderLinkedShipments, deduplicateAgainstVerified } from "./auto-shopify-source.mjs";
import { allocateDatedCohorts } from "./cohort-allocation.mjs";
import { loadSupplementalReceipts } from "./shopifyql-csv-import.mjs";

const ROOT = process.cwd();
const OUTPUT = process.env.OUTPUT_FILE || path.join(ROOT, "data", "inventory_actuals.json");
const MANUAL_FILE = process.env.MANUAL_RECEIPTS_FILE || path.join(ROOT, "data", "manual_receipts.csv");
const API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2026-10").trim();
const START_DATE = String(process.env.INVENTORY_START_DATE || "2026-01-01").trim();
const HISTORY_START_DATE = String(process.env.INVENTORY_HISTORY_START_DATE || START_DATE).trim();
const SHOPIFYQL_PAGE_SIZE = Math.max(100, Math.min(1000, Number(process.env.SHOPIFYQL_PAGE_SIZE || 1000)));
const SHOPIFYQL_MIN_DELAY_MS = Math.max(6000, Math.min(70000, Number(process.env.SHOPIFYQL_MIN_DELAY_MS || 6500)));
const SHOPIFYQL_RETRY_ATTEMPTS = Math.max(2, Math.min(6, Number(process.env.SHOPIFYQL_RETRY_ATTEMPTS || 3)));
const SHOPIFYQL_RETRY_BASE_MS = Math.max(60000, Math.min(90000, Number(process.env.SHOPIFYQL_RETRY_BASE_MS || 65000)));
const RECEIPTS_MODE = String(process.env.INVENTORY_RECEIPTS_MODE || "auto").trim().toLowerCase();

const CONFIGURED_SHOPS = [
  { key: "corro", label: "Corro", store: process.env.CORRO_SHOPIFY_STORE, token: process.env.CORRO_SHOPIFY_TOKEN },
  { key: "cavali", label: "Cavali", store: process.env.CAVALI_SHOPIFY_STORE, token: process.env.CAVALI_SHOPIFY_TOKEN },
];

const STORE_SELECTION=String(process.env.SHOPIFY_STORES||'corro,cavali').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
if(!STORE_SELECTION.length||STORE_SELECTION.some(x=>!['corro','cavali'].includes(x))||new Set(STORE_SELECTION).size!==STORE_SELECTION.length)throw Error('Invalid SHOPIFY_STORES; expected corro, cavali or corro,cavali');
const SHOPS=CONFIGURED_SHOPS.filter(shop=>STORE_SELECTION.includes(shop.key));

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoDate = (v) => (v ? String(v).slice(0, 10) : "");
const monthOf = (v) => (v ? String(v).slice(0, 7) : "");
const norm = (v) => String(v || "").trim().toLowerCase();
const emptyOffsets = () => ({ M0: 0, M1: 0, M2: 0, M3: 0, M4: 0, M5: 0, M6Plus: 0 });

function normalizeStore(v) {
  v = String(v || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (v && !v.includes(".")) v += ".myshopify.com";
  return v;
}
function maxDate(a, b) { return a > b ? a : b; }
function pad2(v) { return String(v).padStart(2, "0"); }
function monthStartFromDate(v) {
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${v}`);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}
function monthEndFromStart(monthStart) {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
function addMonths(monthStart, count = 1) {
  const d = new Date(`${monthStart}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + count);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}
function monthlyRanges(fromDate, throughDate = new Date().toISOString().slice(0, 10)) {
  const ranges = [];
  let cursor = monthStartFromDate(fromDate);
  const lastMonth = monthStartFromDate(throughDate);
  while (cursor <= lastMonth) {
    const fullEnd = monthEndFromStart(cursor);
    ranges.push({
      month: cursor.slice(0, 7),
      start: maxDate(cursor, String(fromDate).slice(0, 10)),
      end: cursor === lastMonth ? String(throughDate).slice(0, 10) : fullEnd,
    });
    cursor = addMonths(cursor, 1);
  }
  return ranges;
}
function monthDiff(a, b) {
  const [ay, am] = String(a).split("-").map(Number);
  const [by, bm] = String(b).split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}
function bucket(diff) {
  return diff <= 0 ? "M0" : diff === 1 ? "M1" : diff === 2 ? "M2" : diff === 3 ? "M3" : diff === 4 ? "M4" : diff === 5 ? "M5" : "M6Plus";
}
function quarterOf(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return "";
  const [y, m] = month.split("-").map(Number);
  return `${y}-Q${Math.ceil(m / 3)}`;
}
function itemKey(row) {
  if (row?.inventoryItemId) return `iid:${row.inventoryItemId}`;
  if (row?.variantId) return `vid:${row.variantId}`;
  if (row?.sku) return `sku:${norm(row.sku)}`;
  return `product:${norm(row?.product)}|${norm(row?.variant)}`;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}
function dedupe(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), r);
  return [...m.values()];
}

function accessToken(shop) {
  const token = String(shop.token || "").trim();
  if (!token) throw new Error(`${shop.label}: missing SHOPIFY_TOKEN`);
  return token;
}

async function gql(shop, token, query, variables = {}) {
  const res = await fetch(`https://${normalizeStore(shop.store)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-shopify-access-token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`${shop.label}: Shopify HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.responseBody = body;
    throw err;
  }
  if (body.errors?.length) {
    const err = new Error(body.errors.map((e) => e.message).join(" | "));
    err.graphqlErrors = body.errors;
    err.responseExtensions = body.extensions || {};
    throw err;
  }
  return body.data;
}

function asGid(type, value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.startsWith("gid://shopify/")) return v;
  return /^\d+$/.test(v) ? `gid://shopify/${type}/${v}` : v;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastShopifyQlStartedAt = 0;

function isRateLimitError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const codes = (error?.graphqlErrors || []).map((x) => String(x?.extensions?.code || "").toUpperCase());
  return codes.includes("THROTTLED") || message.includes("rate limit") || message.includes("rate limited") || message.includes("throttl") || message.includes("too many requests") || message.includes("429");
}

function isResponseTooLargeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const codes = (error?.graphqlErrors || []).map((x) => String(x?.extensions?.code || "").toUpperCase());
  return codes.includes("RESPONSE_TOO_LARGE") || message.includes("response_too_large") || message.includes("request less data");
}

function retryDelayFromError(error, attempt) {
  const gqlErrors = error?.graphqlErrors || [];
  for (const item of gqlErrors) {
    const resetAt = item?.extensions?.cost?.windowResetAt || item?.extensions?.windowResetAt;
    if (resetAt) {
      const delta = Date.parse(resetAt) - Date.now() + 2000;
      if (Number.isFinite(delta) && delta > 0) return Math.min(90000, Math.max(5000, delta));
    }
  }
  // ShopifyQL inventory uses an analytics complexity window. A short 5–10s retry
  // can repeatedly hit the same window, so default to roughly one minute.
  return Math.min(90000, Math.max(5000, SHOPIFYQL_RETRY_BASE_MS * Math.max(1, attempt)));
}

async function waitForShopifyQlWindow() {
  const elapsed = Date.now() - lastShopifyQlStartedAt;
  const waitMs = Math.max(0, SHOPIFYQL_MIN_DELAY_MS - elapsed);
  if (waitMs) await sleep(waitMs);
  lastShopifyQlStartedAt = Date.now();
}

async function shopifyql(shop, token, queryText) {
  const q = `query ShopifyQL($query:String!){
    shopifyqlQuery(query:$query){
      tableData{columns{name dataType displayName} rows}
      parseErrors
      ${API_VERSION >= '2026-10' ? 'parseWarnings' : ''}
    }
  }`;

  for (let attempt = 1; attempt <= SHOPIFYQL_RETRY_ATTEMPTS; attempt += 1) {
    await waitForShopifyQlWindow();
    try {
      const d = await gql(shop, token, q, { query: queryText });
      const r = d?.shopifyqlQuery;
      if (r?.parseErrors?.length) throw new Error(`ShopifyQL parse error: ${r.parseErrors.join(" | ")}`);
      if (!Array.isArray(r?.tableData?.rows)) throw new Error('ShopifyQL returned no table data; refusing to interpret an unavailable response as zero sales.');
      return { rows: r.tableData.rows, warnings: r.parseWarnings || [] };
    } catch (error) {
      if (isResponseTooLargeError(error)) throw error;
      if (!isRateLimitError(error) || attempt >= SHOPIFYQL_RETRY_ATTEMPTS) throw error;
      const backoffMs = retryDelayFromError(error, attempt);
      console.warn(`${shop.label}: ShopifyQL throttled on attempt ${attempt}/${SHOPIFYQL_RETRY_ATTEMPTS}; waiting ${Math.ceil(backoffMs / 1000)}s before retrying...`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`${shop.label}: ShopifyQL retry loop ended unexpectedly`);
}

function rowsForStoreMonth(rows, store, month) {
  return (rows || []).filter((x) => x.store === store && x.month === month);
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

async function fetchMonthlyInventoryHistory(shop, token, catalog, previousRows = []) {
  const byVariantId = new Map(catalog.filter((x) => x.variantId).map((x) => [x.variantId, x]));
  const bySku = new Map(catalog.filter((x) => x.sku).map((x) => [norm(x.sku), x]));
  const out = [];
  const warnings = [];
  const errors = [];
  const ranges = monthlyRanges(HISTORY_START_DATE);
  const thisMonth = currentMonthKey();

  for (const range of ranges) {
    const cached = rowsForStoreMonth(previousRows, shop.key, range.month);
    // Closed months don't change. Once successfully downloaded, keep them instead of
    // re-running 10+ high-cardinality ShopifyQL pages every day.
    if (range.month < thisMonth && cached.length) {
      console.log(`${shop.label}: monthly inventory ${range.month} cache reuse rows=${cached.length}`);
      out.push(...cached);
      continue;
    }

    const monthRows = [];
    let monthFailed = false;
    let monthError = "";
    for (let offset = 0; offset < 500000; offset += SHOPIFYQL_PAGE_SIZE) {
      // Keep ShopifyQL complexity low: one unique dimension and only the four raw
      // inventory metrics needed by the dashboard. Product/vendor/category labels
      // are enriched from the Admin API catalog already loaded above.
      const queryText = `FROM inventory
        SHOW starting_inventory_units, inventory_units_sold, ending_inventory_units,
          ending_inventory_value
        WHERE inventory_is_tracked = true
        GROUP BY product_variant_id
        SINCE ${range.start} UNTIL ${range.end}
        ORDER BY product_variant_id ASC
        LIMIT ${SHOPIFYQL_PAGE_SIZE} OFFSET ${offset}`;
      try {
        const page = await shopifyql(shop, token, queryText);
        warnings.push(...page.warnings);
        console.log(`${shop.label}: monthly inventory ${range.month} offset=${offset} rows=${page.rows.length}`);
        for (const row of page.rows) {
          const variantId = asGid("ProductVariant", row.product_variant_id);
          const cat = byVariantId.get(variantId) || {};
          if (cat.eligibleForInventory === false) continue;
          const sku = String(cat.sku || row.product_variant_sku || "").trim();
          const fallbackCat = cat.variantId ? cat : (bySku.get(norm(sku)) || {});
          const startingUnits = n(row.starting_inventory_units);
          const unitsSold = n(row.inventory_units_sold);
          const endingUnits = n(row.ending_inventory_units);
          const endingInventoryValue = n(row.ending_inventory_value);
          const itemCost = n(fallbackCat.unitCost) || (endingUnits > 0 ? endingInventoryValue / endingUnits : 0);
          monthRows.push({
            historyId: `${shop.key}:${range.month}:${variantId || norm(sku) || monthRows.length}`,
            source: "shopifyql_inventory",
            sourceLabel: "Shopify Inventory History",
            store: shop.key,
            storeLabel: shop.label,
            month: range.month,
            quarter: quarterOf(range.month),
            inventoryItemId: fallbackCat.inventoryItemId || "",
            variantId: variantId || fallbackCat.variantId || "",
            sku: sku || fallbackCat.sku || "",
            product: String(fallbackCat.product || "Unknown product"),
            variant: String(fallbackCat.variant || ""),
            vendor: String(fallbackCat.vendor || "Unknown"),
            category: String(fallbackCat.category || "Uncategorized"),
            startingUnits,
            unitsSold,
            endingUnits,
            netInventoryChange: endingUnits + unitsSold - startingUnits,
            endingInventoryValue,
            unitCost: itemCost,
            currency: fallbackCat.currency || "USD",
            // Recalculated after adjustment history is merged.
            sellThrough: 0,
            sellThroughSource: "derived_after_adjustments",
            isExactPurchaseHistory: false,
          });
        }
        if (page.rows.length < SHOPIFYQL_PAGE_SIZE) break;
      } catch (error) {
        monthFailed = true;
        monthError = error.message;
        console.warn(`${shop.label}: monthly inventory ${range.month} failed at offset=${offset}: ${monthError}`);
        break;
      }
    }

    if (monthFailed) {
      if (cached.length) {
        warnings.push(`${range.month}: refresh failed; kept ${cached.length} cached inventory rows (${monthError}).`);
        out.push(...cached);
      } else {
        errors.push(`${range.month}: ${monthError}`);
      }
    } else {
      out.push(...monthRows);
    }
  }

  return { rows: out, warnings, errors };
}

async function fetchInventoryAdjustmentHistory(shop, token, catalog, previousRows = []) {
  const byVariantId = new Map(catalog.filter((x) => x.variantId).map((x) => [x.variantId, x]));
  const aggregated = new Map();
  const warnings = [];
  const errors = [];
  const thisMonth = currentMonthKey();

  const upsert = (row, month) => {
    const variantId = asGid("ProductVariant", row.product_variant_id);
    const cat = byVariantId.get(variantId) || {};
    if (cat.eligibleForInventory === false) return;
    if (!month) return;
    const key = `${shop.key}|${month}|${variantId || norm(cat.sku)}`;
    const change = n(row.inventory_adjustment_change);
    if (!aggregated.has(key)) {
      aggregated.set(key, {
        adjustmentId: key,
        source: "shopifyql_inventory_adjustment_history",
        sourceLabel: "Shopify Inventory Adjustment History",
        store: shop.key,
        storeLabel: shop.label,
        month,
        quarter: quarterOf(month),
        inventoryItemId: cat.inventoryItemId || "",
        variantId: variantId || cat.variantId || "",
        sku: cat.sku || "",
        product: cat.product || "Unknown product",
        variant: cat.variant || "",
        vendor: cat.vendor || "Unknown",
        category: cat.category || "Uncategorized",
        positiveAdjustments: 0,
        negativeAdjustments: 0,
        netAdjustments: 0,
        reasons: {},
        locations: [],
      });
    }
    const x = aggregated.get(key);
    if (change > 0) x.positiveAdjustments += change;
    if (change < 0) x.negativeAdjustments += change;
    x.netAdjustments += change;
    const reason = String(row.inventory_change_reason || "Unspecified").trim() || "Unspecified";
    x.reasons[reason] = n(x.reasons[reason]) + change;
  };

  for (const range of monthlyRanges(HISTORY_START_DATE)) {
    const cached = rowsForStoreMonth(previousRows, shop.key, range.month);
    if (range.month < thisMonth && cached.length) {
      console.log(`${shop.label}: inventory adjustments ${range.month} cache reuse rows=${cached.length}`);
      for (const r of cached) aggregated.set(r.adjustmentId || `${shop.key}|${range.month}|${itemKey(r)}`, { ...r });
      continue;
    }

    const monthRows = [];
    let monthFailed = false;
    let monthError = "";
    for (let offset = 0; offset < 500000; offset += SHOPIFYQL_PAGE_SIZE) {
      // Keep only variant + reason. This is enough to build positive/negative
      // adjustment totals while avoiding the high-complexity report query.
      const queryText = `FROM inventory_adjustment_history
        SHOW inventory_adjustment_change
        GROUP BY product_variant_id, inventory_change_reason
        HAVING inventory_adjustment_change != 0
        SINCE ${range.start} UNTIL ${range.end}
        ORDER BY product_variant_id ASC, inventory_change_reason ASC
        LIMIT ${SHOPIFYQL_PAGE_SIZE} OFFSET ${offset}`;
      try {
        const page = await shopifyql(shop, token, queryText);
        warnings.push(...page.warnings);
        console.log(`${shop.label}: inventory adjustments ${range.month} offset=${offset} rows=${page.rows.length}`);
        monthRows.push(...page.rows);
        if (page.rows.length < SHOPIFYQL_PAGE_SIZE) break;
      } catch (error) {
        monthFailed = true;
        monthError = error.message;
        console.warn(`${shop.label}: inventory adjustments ${range.month} failed at offset=${offset}: ${monthError}`);
        break;
      }
    }

    if (monthFailed) {
      if (cached.length) {
        warnings.push(`${range.month}: adjustment refresh failed; kept ${cached.length} cached rows (${monthError}).`);
        for (const r of cached) aggregated.set(r.adjustmentId || `${shop.key}|${range.month}|${itemKey(r)}`, { ...r });
      } else {
        errors.push(`${range.month}: ${monthError}`);
      }
    } else {
      for (const row of monthRows) upsert(row, range.month);
    }
  }

  return { rows: [...aggregated.values()], warnings, errors };
}

function mergeAdjustmentsIntoMonthly(monthlyRows, adjustmentRows) {
  const map = new Map(adjustmentRows.map((r) => [`${r.store}|${r.month}|${itemKey(r)}`, r]));
  return monthlyRows.map((r) => {
    const a = map.get(`${r.store}|${r.month}|${itemKey(r)}`);
    const positiveAdjustments = n(a?.positiveAdjustments);
    const negativeAdjustments = n(a?.negativeAdjustments);
    const availableDuringPeriod = n(r.unitsSold) + n(r.endingUnits);
    const derivedSellThrough = availableDuringPeriod > 0 ? (n(r.unitsSold) / availableDuringPeriod) * 100 : 0;
    return {
      ...r,
      positiveAdjustments,
      negativeAdjustments,
      netAdjustments: n(a?.netAdjustments),
      adjustmentReasons: a?.reasons || {},
      adjustmentLocations: a?.locations || [],
      sellThrough: Number.isFinite(derivedSellThrough) ? derivedSellThrough : 0,
      sellThroughSource: "units_sold_over_units_sold_plus_ending_inventory",
    };
  });
}

async function fetchScopes(shop, token) {
  try {
    const d = await gql(shop, token, `query { currentAppInstallation { accessScopes { handle } } }`);
    return d?.currentAppInstallation?.accessScopes?.map((x) => x.handle) || [];
  } catch {
    return [];
  }
}

async function fetchCatalog(shop, token) {
  const q = `query Variants($after:String){
    productVariants(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{
        id title sku inventoryQuantity price
        product{id title vendor productType status brandField:metafield(namespace:"custom",key:"brand"){value type}}
        inventoryItem{id tracked requiresShipping unitCost{amount currencyCode}}
      }
    }
  }`;
  const out = [];
  let after = null;
  do {
    const d = await gql(shop, token, q, { after });
    const c = d?.productVariants;
    for (const v of c?.nodes || []) {
      const tracked = Boolean(v.inventoryItem?.tracked);
      const requiresShipping = Boolean(v.inventoryItem?.requiresShipping);
      const productStatus = String(v.product?.status || "");
      const eligibleForInventory = tracked && requiresShipping && productStatus === "ACTIVE";
      out.push({
        store: shop.key,
        storeLabel: shop.label,
        variantId: v.id,
        inventoryItemId: v.inventoryItem?.id || "",
        sku: v.sku || "",
        product: v.product?.title || "Unknown product",
        variant: v.title || "",
        vendor: v.product?.vendor || "Unknown",
        category: v.product?.productType || "Uncategorized",
        brand: v.product?.brandField?.type === "single_line_text_field" ? v.product.brandField.value : "",
        brandSource: v.product?.brandField?.type === "single_line_text_field" ? "Shopify custom.brand" : "",
        productStatus,
        tracked,
        requiresShipping,
        eligibleForInventory,
        historicalPhysicalItem: tracked && requiresShipping,
        currentUnits: n(v.inventoryQuantity),
        unitCost: n(v.inventoryItem?.unitCost?.amount),
        retailPrice: n(v.price), // Shopify current list price; historical markup is not implied.
        currency: v.inventoryItem?.unitCost?.currencyCode || "USD",
      });
    }
    after = c?.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function fetchShipments(shop, token, catalog) {
  const byId = new Map(catalog.filter((x) => x.inventoryItemId).map((x) => [x.inventoryItemId, x]));
  const q = `query Shipments($after:String){
    inventoryShipments(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{
        id name dateReceived status
        lineItems(first:250){
          nodes{
            id acceptedQuantity
            inventoryItem{id sku tracked requiresShipping unitCost{amount currencyCode}}
          }
        }
      }
    }
  }`;
  const out = [];
  let after = null;
  do {
    const d = await gql(shop, token, q, { after });
    const c = d?.inventoryShipments;
    for (const sh of c?.nodes || []) {
      const cohortDate = isoDate(sh.dateReceived);
      if (!cohortDate || cohortDate < START_DATE) continue;
      for (const line of sh.lineItems?.nodes || []) {
        const qty = n(line.acceptedQuantity);
        if (qty <= 0) continue;
        const iid = line.inventoryItem?.id || "";
        const cat = byId.get(iid) || {};
        if (cat.eligibleForInventory === false) continue;
        out.push({
          receiptId: `${sh.id}:${line.id}`,
          sourceId: sh.name || sh.id,
          source: "shopify_inventory_shipment",
          sourceLabel: "Shopify receipt",
          cohortType: "receipt",
          dateBasis: "received",
          isEstimated: false,
          store: shop.key,
          storeLabel: shop.label,
          cohortDate,
          cohortMonth: monthOf(cohortDate),
          cohortQuarter: quarterOf(monthOf(cohortDate)),
          receivedAt: cohortDate,
          receivedMonth: monthOf(cohortDate),
          inventoryItemId: iid,
          variantId: cat.variantId || "",
          sku: line.inventoryItem?.sku || cat.sku || "",
          product: cat.product || "Unknown product",
          variant: cat.variant || "",
          vendor: cat.vendor || "Unknown",
          category: cat.category || "Uncategorized",
          unitsReceived: qty,
          unitCost: n(line.inventoryItem?.unitCost?.amount ?? cat.unitCost),
          costBasis: "current_item_cost", // Shopify inventoryItem unitCost is not the historical receipt price.
          retailPrice: n(cat.retailPrice),
          currency: line.inventoryItem?.unitCost?.currencyCode || cat.currency || "USD",
        });
      }
    }
    after = c?.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null;
  } while (after);
  return out;
}

async function fetchPurchaseOrders(shop, token) {
  // Fetch only PO metadata in this list. Requesting 100 purchase orders with
  // 250 lines each exceeds Shopify's GraphQL cost limits on real stores.
  // The per-PO detailed reader below fetches ALL line items in small pages.
  const q = `query PurchaseOrders($after:String){
    inventoryPurchaseOrders(first:100,after:$after){
      pageInfo{hasNextPage endCursor}
      nodes{id name orderedAt dateCreated status currency}
    }
  }`;
  const documents = [];
  let after = null;
  do {
    const d = await gql(shop, token, q, { after });
    const c = d?.inventoryPurchaseOrders;
    for (const po of c?.nodes || []) {
      if (String(po.status || "").toUpperCase() !== "CANCELED") documents.push(po);
    }
    after = c?.pageInfo?.hasNextPage ? c.pageInfo.endCursor : null;
  } while (after);
  return { rows: [], documents };
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ""; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function manualReceipts() {
  let txt = "";
  try { txt = await fs.readFile(MANUAL_FILE, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const verified = parseVerifiedReceiptsCsv(txt, {startDate: START_DATE});
  return verified.map(r => {
    const cohortDate = r.received_at;
    const sku = r.sku;
    const unitCost = r.unit_cost;
    return {
      // A single receipt_id can include many distinct products; never collapse them.
      receiptId: `manual:${r.store}:${r.receipt_id}:${cohortDate}:${sku.toLowerCase()}`,
      sourceId: r.receipt_id,
      source: "manual_csv",
      sourceLabel: "Verified supplier receiving CSV",
      cohortType: "receipt",
      dateBasis: "received",
      isEstimated: false,
      store: r.store,
      storeLabel: r.store === "corro" ? "Corro" : "Cavali",
      cohortDate,
      cohortMonth: monthOf(cohortDate),
      cohortQuarter: quarterOf(monthOf(cohortDate)),
      receivedAt: cohortDate,
      receivedMonth: monthOf(cohortDate),
      inventoryItemId: "",
      variantId: "",
      sku,
      product: r.product || "",
      variant: "",
      vendor: r.vendor || "",
      category: r.category || "",
      unitsReceived: r.units_received,
      unitCost: unitCost ?? 0,
      costBasis: unitCost !== null ? "manual_recorded_cost" : "unavailable",
      currency: r.currency,
    };
  });
}

function enrichManual(rows, catalog) {
  const bySku = new Map(catalog.filter((x) => x.sku).map((x) => [norm(x.sku), x]));
  return rows.map((r) => {
    const c = bySku.get(norm(r.sku)) || {};
    return {
      ...r,
      inventoryItemId: r.inventoryItemId || c.inventoryItemId || "",
      variantId: r.variantId || c.variantId || "",
      product: r.product || c.product || "Unknown product",
      variant: r.variant || c.variant || "",
      vendor: r.vendor || c.vendor || "Unknown",
      category: r.category || c.category || "Uncategorized",
      unitCost: r.costBasis === "manual_recorded_cost" ? r.unitCost : (c.unitCost || 0),
      costBasis: r.costBasis === "manual_recorded_cost" ? "manual_recorded_cost" : (c.unitCost > 0 ? "current_item_cost" : "unavailable"),
      retailPrice: n(c.retailPrice),
      currency: r.currency || c.currency || "USD",
      eligibleForInventory: c.eligibleForInventory !== false,
    };
  }).filter((r) => r.eligibleForInventory !== false);
}

function removeManualDuplicates(manual, primary) {
  const signatures = new Set(primary.map((r) => `${r.store}|${norm(r.sku)}|${r.cohortDate}|${n(r.unitsReceived)}`));
  return manual.filter((r) => !signatures.has(`${r.store}|${norm(r.sku)}|${r.cohortDate}|${n(r.unitsReceived)}`));
}

function chooseCohortInputs(mode, linkedReceipts, manual, purchaseOrders) {
  if (mode === "manual") return {rows: manual, source: "Legacy verified CSV (explicit opt-in)"};
  // The project defaults to Shopify-only. Neither internal transfers nor
  // undelivered purchase orders are accepted as merchandise received.
  if (linkedReceipts.length) return {rows: linkedReceipts, source: "Shopify linked PO receipts / purchase-reference events"};
  return {rows: [], source: purchaseOrders.length ? "Shopify POs found; no documented received stock" : "Shopify supplier receipts unavailable"};
}


async function main() {
  const previous = await readInventorySource({root:ROOT,legacyFile:OUTPUT,allowMissing:true}) || { sales: [], receipts: [], currentInventory: [], purchaseOrders: [], monthlyInventory: [], monthlyAdjustments: [] };
  const manualAll = RECEIPTS_MODE === "manual" ? await manualReceipts() : []; // Shopify-only automatic mode never requires a CSV.
  const warnings = [];
  const stores = {};
  const allSales = [];
  const allCohortInputs = [];
  const allCohorts = [];
  const allInventory = [];
  const allPurchaseOrders = [];
  const allShipments = [];
  const allObservedRestocks = [];
  const allNativeRestockEvents = [];
  const allMonthlyInventory = [];
  const allMonthlyAdjustments = [];
  const allReceiptMonthLedger = [];

  for (const shop of SHOPS) {
    const domain = normalizeStore(shop.store);
    const hasAuth = Boolean(String(shop.token || "").trim());

    if (!domain || !hasAuth) {
      warnings.push(`${shop.label}: Shopify credentials are not configured.`);
      stores[shop.key] = { label: shop.label, ok: false, status: "credentials_missing", cohortSource: "Unavailable" };
      continue;
    }

    console.log(`Syncing ${shop.label}...`);
    try {
      const token = accessToken(shop);
      const scopes = await fetchScopes(shop, token);
      const catalog = await fetchCatalog(shop, token);
      const {shop:shopInfo} = await gql(shop,token,'query SalesCalendar { shop { ianaTimezone currencyCode } }');
      const timezone = shopInfo?.ianaTimezone;
      if (!timezone) throw new Error('Shopify did not return the store timezone for dated sales.');
      const todayParts = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
      const part = name => todayParts.find(p=>p.type===name).value;
      const today = `${part('year')}-${part('month')}-${part('day')}`;
      const salesThrough = new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
      // Re-read the whole reporting interval. Refunds/order edits can change old
      // dates, so a closed month or a nonempty order cache is not completeness.
      const dailySales = await readShopifyDailySales({shop,token,catalog,startDate:START_DATE,endDate:salesThrough,shopifyql,pageSize:SHOPIFYQL_PAGE_SIZE,includeCosts:true,includeFinancials:true,
        onProgress:month=>console.log(`${shop.label}: daily sales ${month.month}: ${month.rows} rows, ${month.quantityOrdered} ordered, ${month.netUnits} net; ${month.unidentifiedProductRows} rows without product identity retained.`)});
      warnings.push(...dailySales.warnings);
      const sales = dailySales.sales.map(row=>({...row,currency:shopInfo.currencyCode || row.currency}));

      let monthlyInventory = [];
      let monthlyInventoryError = "";
      let monthlyInventoryWarnings = [];
      let monthlyAdjustments = [];
      let monthlyAdjustmentsError = "";
      let monthlyAdjustmentsWarnings = [];
      const previousMonthlyForStore = (previous.monthlyInventory || []).filter((x) => x.store === shop.key);
      const previousAdjustmentsForStore = (previous.monthlyAdjustments || []).filter((x) => x.store === shop.key);
      try {
        const history = await fetchMonthlyInventoryHistory(shop, token, catalog, previousMonthlyForStore);
        monthlyInventory = history.rows;
        monthlyInventoryWarnings = history.warnings;
        monthlyInventoryError = history.errors?.join(" | ") || "";
      } catch (e) {
        monthlyInventoryError = e.message;
        monthlyInventory = previousMonthlyForStore;
      }

      try {
        const adjustments = await fetchInventoryAdjustmentHistory(shop, token, catalog, previousAdjustmentsForStore);
        monthlyAdjustments = adjustments.rows;
        monthlyAdjustmentsWarnings = adjustments.warnings;
        monthlyAdjustmentsError = adjustments.errors?.join(" | ") || "";
      } catch (e) {
        monthlyAdjustmentsError = e.message;
        monthlyAdjustments = previousAdjustmentsForStore;
      }
      monthlyInventory = mergeAdjustmentsIntoMonthly(monthlyInventory, monthlyAdjustments);

      let shipments = [];
      let shipmentError = "";
      if (RECEIPTS_MODE !== "manual" && RECEIPTS_MODE !== "purchase_orders") {
        try { shipments = await fetchShipments(shop, token, catalog); }
        catch (e) { shipmentError = e.message; }
      }

      let purchaseOrders = [];
      let purchaseOrderDocuments = [];
      let purchaseOrderError = "";
      if (RECEIPTS_MODE === "auto" || RECEIPTS_MODE === "purchase_orders") {
        try { const result = await fetchPurchaseOrders(shop, token); purchaseOrders = result.rows; purchaseOrderDocuments = result.documents; }
        catch (e) { purchaseOrderError = e.message; }
      }

      // Source of truth for supplier merchandise: PO-linked RECEIVED shipments
      // and clearly purchase-referenced positive receiving events. No Excel
      // is required and generic inventory shipments are NOT treated as buys.
      // Refresh historical cached events once when a newer purchase-order reason
      // query is deployed; old caches omitted purchase_order_received.
      const previousNative = Number(previous.meta?.receiptEventQueryVersion)===3
        ?(previous.nativeRestockEvents || []).filter(r=>r.store===shop.key):[];
      let native = {events:previousNative,warnings:[],loadedMonths:0,coverage:{}};
      try {
        native = await readShopifyRestockEvidence({
          shop, token, catalog, startDate:START_DATE, ranges:monthlyRanges(START_DATE),
          previousEvents:previousNative,
          monthlySignals:Object.fromEntries(monthlyRanges(START_DATE).map(({month})=>[month,monthlyAdjustments.filter(r=>r.month===month).reduce((sum,r)=>sum+Math.max(0,n(r.reasons?.purchase_order_received))+Math.max(0,n(r.reasons?.restock)),0)])),
          shopifyql,pageSize:SHOPIFYQL_PAGE_SIZE,
        });
      }catch(error){native.warnings.push(`${shop.label}: failed to scan Shopify event history: ${error.message}`);}
      warnings.push(...native.warnings);
      let linked = {rows:[],warnings:[]};
      if (purchaseOrderDocuments.length) {
        try {linked=await readPurchaseOrderLinkedShipments({shop,token,purchaseOrders:purchaseOrderDocuments,catalog,startDate:START_DATE,gql});}
        catch(error){linked.warnings.push(`${shop.label}: unable to read purchase linked shipment receipts: ${error.message}`);}
      }
      warnings.push(...linked.warnings);
      const documented = native.events.filter(e=>e.cohortType==='receipt');
      // Optional verified CSV evidence fills gaps left by unsupported ShopifyQL
      // reference dimensions. Matching PO/date/SKU is never added twice.
      const archived = await loadSupplementalReceipts({root:ROOT,store:shop.key,catalog,startDate:START_DATE});
      const nativeKeys = new Map(documented.map(e=>[JSON.stringify([e.cohortDate,e.variantId,e.sourceDocument]),e]));
      const historical = archived.events.filter(e=>{
        const key=JSON.stringify([e.cohortDate,e.variantId,e.sourceDocument]);
        const known=nativeKeys.get(key);
        if (!known)return true;
        if (Number(known.unitsReceived)!==Number(e.unitsReceived))warnings.push(`${shop.label}: PO ${e.cohortDate} ${e.sku} differs between API and CSV; using live API (${known.unitsReceived}), CSV (${e.unitsReceived}) requires review.`);
        return false;
      });
      if(archived.unattributedUnits>0)warnings.push(`${shop.label}: imported ShopifyQL history includes ${archived.unattributedUnits} PO-received units without variant/SKU; excluded from SKU cohorts pending Shopify reconciliation.`);
      if(archived.unmatchedCatalogUnits>0)warnings.push(`${shop.label}: ${archived.unmatchedCatalogUnits} imported PO-received units refer to variants absent from the current Shopify catalog; excluded from FIFO cohorts.`);
      const nonOverlappingDocuments=deduplicateAgainstVerified([...documented,...historical],linked.rows);
      const supplierReceipts=[...linked.rows,...nonOverlappingDocuments];
      // Preserve the legacy informational list of PO lines, but NEVER treat an
      // ordered quantity as physically received when calculating rotation.
      purchaseOrders = linked.purchaseOrderRows || [];
      const manual = RECEIPTS_MODE === 'manual' ? enrichManual(manualAll.filter(x=>x.store===shop.key),catalog) : [];
      const chosen = chooseCohortInputs(RECEIPTS_MODE,supplierReceipts,manual,purchaseOrderDocuments);
      const cohortInputs=dedupe(chosen.rows,x=>x.receiptId);
      const observedInputs=deduplicateAgainstVerified(native.events.filter(e=>e.cohortType==='restock'),cohortInputs);
      // One SKU ledger for all lots: allocating the two evidence types
      // independently would consume opening stock and sales twice.
      const allocation=allocateDatedCohorts({shop,receipts:[...cohortInputs,...observedInputs],inventoryReturns:native.events.filter(row=>row.cohortType==='return'),sales,catalog,openingHistory:monthlyInventory,startDate:START_DATE});
      const restockAnalysis={...allocation,cohorts:allocation.cohorts.filter(r=>r.cohortType==='restock')};
      for(const r of restockAnalysis.cohorts){
        const status=native.coverage?.[r.cohortMonth]?.status;
        if(status==='error'||status==='inconsistent'){
          r.soldWithinDays={};r.allocationConfidence='incomplete_daily_adjustments';
        }
      }
      allNativeRestockEvents.push(...native.events);
      allObservedRestocks.push(...restockAnalysis.cohorts);
      console.log(`${shop.label}: Shopify receipt sources: PO-linked ${linked.rows.length}, ShopifyQL references ${documented.length}, verified archive ${historical.length}, observed restock events ${observedInputs.length}.`);
      const a = {...allocation,cohorts:allocation.cohorts.filter(r=>r.cohortType!=='restock')};
      for (const c of [...a.cohorts,...restockAnalysis.cohorts]) {
        c.salesMetric='quantity_ordered';
        c.salesSource='shopifyql_sales';
        c.salesThrough=salesThrough;
      }

      const eligibleCatalog = catalog.filter((x) => x.eligibleForInventory !== false);
      const excludedUntracked = catalog.filter((x) => !x.tracked).length;
      const excludedNonShipping = catalog.filter((x) => x.tracked && !x.requiresShipping).length;
      const excludedInactive = catalog.filter((x) => x.tracked && x.requiresShipping && x.productStatus !== "ACTIVE").length;

      if (!cohortInputs.length) {
        warnings.push(`${shop.label}: exact purchase/receipt cohort history was not returned. Monthly Shopify inventory history will be used when available, without labeling net inventory changes as purchases.`);
      }
      if (monthlyInventoryError) warnings.push(`${shop.label}: Shopify Inventory History incomplete/unavailable (${monthlyInventoryError}).`);
      if (monthlyInventoryWarnings.length) warnings.push(`${shop.label}: Shopify Inventory History warnings (${monthlyInventoryWarnings.slice(0, 2).join(" | ")}).`);
      if (monthlyAdjustmentsError) warnings.push(`${shop.label}: Inventory Adjustment History incomplete/unavailable (${monthlyAdjustmentsError}).`);
      if (monthlyAdjustmentsWarnings.length) warnings.push(`${shop.label}: Inventory Adjustment History warnings (${monthlyAdjustmentsWarnings.slice(0, 2).join(" | ")}).`);
      if (shipmentError) warnings.push(`${shop.label}: Inventory Shipments not available (${shipmentError}).`);
      if (purchaseOrderError && !purchaseOrders.length) warnings.push(`${shop.label}: Purchase Orders not available (${purchaseOrderError}).`);
      if (a.unallocatedUnits > 0) warnings.push(`${shop.label}: ${a.unallocatedUnits} sold units across ${a.unallocatedItems} items could not be allocated to a purchase cohort.`);

      allSales.push(...sales);
      allCohortInputs.push(...cohortInputs);
      allCohorts.push(...a.cohorts);
      allInventory.push(...a.inventory);
      allPurchaseOrders.push(...purchaseOrders);
      allShipments.push(...shipments);
      allMonthlyInventory.push(...monthlyInventory);
      allMonthlyAdjustments.push(...monthlyAdjustments);
      allReceiptMonthLedger.push(...allocation.receiptMonthLedger);

      stores[shop.key] = {
        label: shop.label,
        ok: true,
        status: "synced",
        store: domain,
        scopes,
        catalogVariants: catalog.length,
        eligibleInventoryVariants: eligibleCatalog.length,
        excluded: { untracked: excludedUntracked, nonShipping: excludedNonShipping, inactive: excludedInactive },
        salesRows: sales.length,
        salesSyncFrom: START_DATE,
        salesSource: 'shopifyql_sales',
        salesMetric: 'quantity_ordered',
        salesThrough,
        salesTimezone: timezone,
        salesDailyCoverage: dailySales.coverage,
        monthlyInventoryRows: monthlyInventory.length,
        monthlyAdjustmentRows: monthlyAdjustments.length,
        monthlyInventorySource: monthlyInventory.length ? "ShopifyQL Inventory History" : "Unavailable",
        monthlyInventoryError,
        monthlyAdjustmentsError,
        shipmentRows: shipments.length,
        purchaseOrderRows: purchaseOrders.length,
        manualRows: manual.length,
        cohortRows: cohortInputs.length,
        nativeRestockRows: observedInputs.length,
        nativeDailyCoverage: native.coverage,
        nativeDailyWarnings: native.warnings.slice(0,12),
        missingOpeningSkus: a.missingOpeningSkus,
        purchaseLinkedShipmentRows: linked.rows.length,
        purchaseReferencedRows: documented.length,
        supplementaryVerifiedRows: historical.length,
        supplementaryArchiveMonths: archived.months,
        supplementaryUnattributedUnits: archived.unattributedUnits,
        supplementaryMissingCatalogUnits: archived.unmatchedCatalogUnits,
        supplementaryMatchedReceiptUnits: archived.matchedReceiptUnits,
        readAllOrders: scopes.includes("read_all_orders"),
        receiptPermissions: { purchaseOrders: scopes.includes("read_inventory_purchase_orders") && !purchaseOrderError, inventoryShipments: scopes.includes("read_inventory_shipments") && !shipmentError, inventory: scopes.includes("read_inventory") },
        purchaseOrderError,
        purchaseOrderDocuments: purchaseOrderDocuments.length,
        cohortSource: chosen.source,
        cohortDateBasis: cohortInputs.some((r) => r.dateBasis === "received") ? "received" : cohortInputs.some((r) => r.dateBasis === "ordered") ? "ordered" : "none",
        shipmentError,
        purchaseOrderError,
        openingEstimateUnitsInternal: a.openingEstimateUnits,
      };
    } catch (e) {
      warnings.push(`${shop.label}: sync failed — ${e.message}`);
      stores[shop.key] = { label: shop.label, ok: false, status: "sync_failed", error: e.message, cohortSource: "Previous data only" };
      const oldSales = (previous.sales || []).filter((x) => x.store === shop.key);
      allNativeRestockEvents.push(...(previous.nativeRestockEvents || []).filter(x=>x.store===shop.key));
      allObservedRestocks.push(...(previous.observedRestockCohorts || []).filter(x=>x.store===shop.key));
      const oldInputs = (previous.cohortInputs || previous.receipts || []).filter((x) => x.store === shop.key);
      const oldInv = (previous.currentInventory || []).filter((x) => x.store === shop.key);
      const oldMonthly = (previous.monthlyInventory || []).filter((x) => x.store === shop.key);
      const oldAdjustments = (previous.monthlyAdjustments || []).filter((x) => x.store === shop.key);
      allSales.push(...oldSales);
      allCohortInputs.push(...oldInputs);
      allInventory.push(...oldInv);
      allMonthlyInventory.push(...mergeAdjustmentsIntoMonthly(oldMonthly, oldAdjustments));
      allMonthlyAdjustments.push(...oldAdjustments);
      if (oldInv.length || oldInputs.length || oldSales.length) {
        const a = allocateDatedCohorts({shop,receipts:oldInputs,sales:oldSales,catalog:oldInv,openingHistory:oldMonthly,startDate:START_DATE});
        allCohorts.push(...a.cohorts);
        allReceiptMonthLedger.push(...a.receiptMonthLedger);
      }
    }
  }

  const ok = Object.values(stores).filter((x) => x.ok).length;
  // A failed migration must not publish a freshly dated report containing old
  // order quantities. Leave the entire previous file untouched; Actions fails.
  if (ok !== SHOPS.length) throw new Error(`Shopify sync incomplete: ${Object.entries(stores).filter(([,s])=>!s.ok).map(([key,s])=>`${key}: ${s.error || s.status}`).join(' | ')}`);
  const cohortRows = allCohorts.length;
  const rawPayload = {
    meta: {
      status: ok ? "ok" : "not_synced",
      generatedAt: new Date().toISOString(),
      apiVersion: API_VERSION,
      startDate: START_DATE,
      historyStartDate: HISTORY_START_DATE,
      shopifyqlPageSize: SHOPIFYQL_PAGE_SIZE,
      shopifyqlMinDelayMs: SHOPIFYQL_MIN_DELAY_MS,
      shopifyqlRetryAttempts: SHOPIFYQL_RETRY_ATTEMPTS,
      shopifyqlRetryBaseMs: SHOPIFYQL_RETRY_BASE_MS,
      salesSyncFrom: START_DATE,
      salesRefreshPolicy: 'full_reporting_interval_each_sync',
      salesSourceVersion: 1,
      salesSource: 'shopifyql_sales',
      receiptsMode: RECEIPTS_MODE,
      receiptEventQueryVersion: 3,
      allocationMethod: "FIFO_ESTIMATE_WITH_OPENING_BASELINE",
      dashboardMode: cohortRows ? "cohort" : allMonthlyInventory.length ? "history" : "snapshot",
      warnings,
      stores,
    },
    nativeRestockEvents: dedupe(allNativeRestockEvents,x=>x.receiptId),
    observedRestockCohorts: dedupe(allObservedRestocks,x=>x.receiptId),
    cohorts: allCohorts.sort((a, b) => b.cohortDate.localeCompare(a.cohortDate) || String(a.vendor).localeCompare(String(b.vendor))),
    cohortInputs: dedupe(allCohortInputs, (x) => x.receiptId),
    currentInventory: dedupe(allInventory, (x) => `${x.store}|${itemKey(x)}`),
    monthlyInventory: dedupe(allMonthlyInventory, (x) => x.historyId || `${x.store}|${x.month}|${itemKey(x)}`),
    monthlyAdjustments: dedupe(allMonthlyAdjustments, (x) => x.adjustmentId || `${x.store}|${x.month}|${itemKey(x)}`),
    receiptMonthLedger: dedupe(allReceiptMonthLedger, (x) => `${x.store}|${x.month}|${itemKey(x)}`),
    sales: dedupe(allSales, (x) => x.saleId),
    shipments: dedupe(allShipments, (x) => x.receiptId),
    purchaseOrders: dedupe(allPurchaseOrders, (x) => x.receiptId),
    // Backwards compatibility with the first version of this project.
    receipts: dedupe(allCohortInputs.filter((x) => x.cohortType === "receipt"), (x) => x.receiptId),
  };

  const payload=normalizeReceiptData(rawPayload);
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  // Compact JSON preserves all fields but keeps the historical GitHub file below its size limit.
  await fs.writeFile(OUTPUT, `${JSON.stringify(payload)}\n`);
  console.log(`Wrote ${OUTPUT}`);
  console.log(`mode=${payload.meta.dashboardMode} cohorts=${payload.cohorts.length} monthlyInventory=${payload.monthlyInventory.length} monthlyAdjustments=${payload.monthlyAdjustments.length} inventory=${payload.currentInventory.length} sales=${payload.sales.length} shipments=${payload.shipments.length} purchaseOrders=${payload.purchaseOrders.length} observedRestocks=${payload.observedRestockCohorts.length}`);
  if (warnings.length) console.warn(warnings.join("\n"));
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exitCode = 1;
});
