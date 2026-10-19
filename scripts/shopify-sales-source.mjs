/**
 * Dated Shopify Analytics sales, read independently of the Orders API's order
 * access window. This is the same sales schema as the ShopifyQL editor.
 *
 * quantity_ordered counts orders before reversals; net_items_sold includes
 * reversals on their Shopify reporting dates. Keep both: neither is interchangeable
 * with inventory_units_sold (inventory/fulfilment movement).
 *
 * Shopify schema and stable LIMIT/OFFSET pagination:
 * https://shopify.dev/docs/api/shopifyql/2026-07/schemas/sales_revenue/sales
 * https://shopify.dev/docs/api/shopifyql/latest/syntax/limit
 */
const dimensions = ['day', 'product_variant_id', 'product_variant_sku', 'product_vendor', 'product_title', 'product_variant_title'];
const str = value => String(value ?? '').trim();
const variantGid = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Unsafe numeric Shopify variant ID');
  const raw = str(value);
  return /^\d+$/.test(raw) ? `gid://shopify/ProductVariant/${raw}` : raw;
};

function validDate(value, name) {
  const raw = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new TypeError(`${name} must be an ISO date`);
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw) throw new TypeError(`${name} is not a valid date`);
  return raw;
}

function integer(value, name) {
  if (value === null || value === undefined || str(value) === '') throw new Error(`ShopifyQL sales row is missing ${name}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ShopifyQL sales ${name}: ${str(value)}`);
  return number;
}

function monthRanges(startDate, endDate) {
  const ranges = [];
  let start = startDate;
  while (start <= endDate) {
    const [year, month] = start.split('-').map(Number);
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    ranges.push({month: start.slice(0, 7), start, end: monthEnd < endDate ? monthEnd : endDate});
    start = nextMonth;
  }
  return ranges;
}

export function dailySalesQuery(range, {offset = 0, limit = 1000, includeCosts = false, includeFinancials = false} = {}) {
  const start = validDate(range.start, 'range.start');
  const end = validDate(range.end, 'range.end');
  if (start > end) throw new RangeError('Sales range start exceeds end');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid sales query pagination');
  return `FROM sales\nSHOW quantity_ordered, net_items_sold${includeCosts ? ', cost_of_goods_sold' : ''}${includeFinancials ? ', net_sales, gross_sales, discounts' : ''}\nGROUP BY ${dimensions.join(', ')}\nSINCE ${start} UNTIL ${end}\nORDER BY ${dimensions.map(name => `${name} ASC`).join(', ')}\nLIMIT ${limit} OFFSET ${offset}`;
}

function isTotalRow(row) {
  // No WITH TOTALS is requested. Discard explicitly labelled subtotal rows if
  // an API/adapter returns them, without mistaking an anonymous real SKU for one.
  return row?.__is_total === true || row?.__is_total__ === true || row?.is_total === true ||
    /^(total|totals|all)$/i.test(str(row?.day)) ||
    (row?.day == null && row?.product_variant_id == null && row?.product_variant_sku == null &&
      row?.quantity_ordered != null && row?.net_items_sold != null);
}

function parseRow(row, shop, byVariant, range) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('ShopifyQL sales rows must be named-column objects');
  if (isTotalRow(row)) return null;
  // Shopify day dimensions are already in the shop reporting timezone. Do not
  // convert them through UTC and shift late-evening transactions to another day.
  const soldAt = validDate(str(row.day).slice(0, 10), 'ShopifyQL sales day');
  if (soldAt < range.start || soldAt > range.end) throw new Error(`ShopifyQL sales day ${soldAt} lies outside requested month`);
  const variantId = variantGid(row.product_variant_id);
  if (variantId && !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(variantId)) throw new Error(`Invalid ShopifyQL sales variant ID: ${variantId}`);
  const item = byVariant.get(variantId);
  const quantityOrdered = integer(row.quantity_ordered, 'quantity_ordered');
  const netUnits = integer(row.net_items_sold, 'net_items_sold');
  if (quantityOrdered < 0) throw new Error('ShopifyQL quantity_ordered cannot be negative');
  const sku = str(row.product_variant_sku) || str(item?.sku);
  const vendor = str(row.product_vendor) || str(item?.vendor) || 'Unknown';
  const product = str(row.product_title) || str(item?.product);
  const variant = str(row.product_variant_title) || str(item?.variant);
  // Analytics can contain valid dated sales/reversals without product metadata.
  // Keep their metrics for vendor totals, but never attach them to a stock SKU.
  const unidentifiedProduct = !variantId && !sku && !product;
  const cost = row.cost_of_goods_sold;
  const costPresent = cost !== null && cost !== undefined && str(cost) !== '';
  if (costPresent && !Number.isFinite(Number(cost))) throw new Error('Invalid ShopifyQL cost_of_goods_sold');
  const financials = {};
  for (const [source, field] of [['net_sales','netSales'],['gross_sales','grossSales'],['discounts','discounts']]) {
    if (row[source] == null || str(row[source]) === '') continue;
    if (!Number.isFinite(Number(row[source]))) throw new Error(`Invalid ShopifyQL ${source}`);
    financials[field] = Number(row[source]);
    financials[`${field}Source`] = `shopifyql_${source}`;
  }
  return {
    ...item, ...financials,
    store: shop.key, storeLabel: shop.label,
    saleId: `shopifyql:sales:${shop.key}:${encodeURIComponent(JSON.stringify(dimensions.map(name => row[name] ?? null)))}`,
    source: 'shopifyql_sales', sourceLabel: 'Shopify Analytics sales',
    soldAt, variantId, inventoryItemId: item?.inventoryItemId || '',
    sku, vendor, product, variant, category: item?.category || '',
    // The allocator consumes gross dated sales. Never clamp signed net sales:
    // a refund-only day legitimately has quantityOrdered=0 and netUnits<0.
    units: quantityOrdered, quantityOrdered, netUnits,
    salesMetric: 'quantity_ordered', netSalesMetric: 'net_items_sold',
    ...(costPresent ? {costOfGoodsSold:Number(cost),costSource:'shopifyql_cost_of_goods_sold'} : {}),
    historicalPhysicalItem: unidentifiedProduct ? false : item ? item.tracked !== false && item.requiresShipping !== false : undefined,
    ...(unidentifiedProduct ? {eligibleForInventory:false,productIdentityStatus:'unavailable'} : {}),
  };
}

/**
 * The injected helper has the existing (shop, token, query) signature and returns
 * {rows: object[], warnings?: string[]}. Callers own authentication and retries.
 * Explicit endDate is required: callers choose the last complete store-local day.
 *
 * Reject the entire read when any month cannot be fully paged. A successful
 * earlier month must never be persisted as a supposedly complete replacement.
 */
export async function readShopifyDailySales({shop, token, catalog = [], startDate, endDate, shopifyql, pageSize = 1000, maxRowsPerMonth = 100000, includeCosts = false, includeFinancials = false, onProgress = () => {}}) {
  startDate = validDate(startDate, 'startDate');
  endDate = validDate(endDate, 'endDate');
  if (startDate > endDate) throw new RangeError('Sales startDate exceeds endDate');
  if (!shop?.key || typeof shopifyql !== 'function') throw new TypeError('Shop and ShopifyQL helper are required');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000 || !Number.isSafeInteger(maxRowsPerMonth) || maxRowsPerMonth < pageSize) throw new RangeError('Invalid daily sales pagination limits (pageSize must be 1–1000)');
  const byVariant = new Map(catalog.filter(item => item.variantId && (!item.store || item.store === shop.key)).map(item => [variantGid(item.variantId), item]));
  const sales = [], coverage = {}, warnings = [];
  const missingCatalog = new Set();
  for (const range of monthRanges(startDate, endDate)) {
    const monthSales = [], identities = new Set(), pageFingerprints = new Set();
    let rowsRead = 0, pages = 0, complete = false;
    let costsEnabled = includeCosts;
    let financialsEnabled = includeFinancials;
    try {
      for (let offset = 0; offset <= maxRowsPerMonth; offset += pageSize) {
        let page;
        for (let attempt=0;attempt<3;attempt++) {
          try {
            page=await shopifyql(shop,token,dailySalesQuery(range,{offset,limit:pageSize,includeCosts:costsEnabled,includeFinancials:financialsEnabled}));
            if(page?.errors?.length||page?.parseErrors?.length)throw new Error(JSON.stringify(page.errors||page.parseErrors));
            break;
          } catch(error) {
            page=null;
            if(offset!==0||!/unknown|invalid|unsupported|not (?:found|available|supported)|does not exist/i.test(error.message))throw error;
            if(financialsEnabled&&/net_sales|gross_sales|discounts/i.test(error.message)) {
              financialsEnabled=false;
              warnings.push(`${shop.label||shop.key} ${range.month}: optional financial metrics unavailable; ordered/net units retained.`);
            } else if(costsEnabled&&/cost_of_goods_sold/i.test(error.message)) {
              costsEnabled=false;
              warnings.push(`${shop.label||shop.key} ${range.month}: Shopify does not expose cost_of_goods_sold; ordered/net sales retained without a cost substitute.`);
            } else throw error;
          }
        }
        pages++;
        if (!page || !Array.isArray(page.rows)) throw new Error('ShopifyQL sales response has no rows array');
        if (page.errors?.length || page.parseErrors?.length) throw new Error(`ShopifyQL sales error: ${(page.errors || page.parseErrors).join(' | ')}`);
        if (page.hasNextPage === true && page.rows.length < pageSize) throw new Error('ShopifyQL sales response is explicitly incomplete');
        for (const warning of page.warnings || page.parseWarnings || []) {
          const message = typeof warning === 'string' ? warning : JSON.stringify(warning);
          if (/truncat|incomplete|partial result|row limit|maximum.*rows/i.test(message)) throw new Error(`Incomplete ShopifyQL sales response: ${message}`);
          const labelled = `${shop.label || shop.key} ${range.month}: ${message}`;
          if (!warnings.includes(labelled)) warnings.push(labelled);
        }
        if (page.rows.length > pageSize) throw new Error('ShopifyQL sales page exceeds requested limit');
        rowsRead += page.rows.length;
        if (rowsRead > maxRowsPerMonth) throw new Error(`Daily sales exceed ${maxRowsPerMonth} rows; cannot certify completeness`);
        const fingerprint = JSON.stringify(page.rows);
        if (page.rows.length && pageFingerprints.has(fingerprint)) throw new Error('ShopifyQL sales repeated a page; OFFSET was not applied');
        pageFingerprints.add(fingerprint);
        for (const raw of page.rows) {
          const row = parseRow(raw, shop, byVariant, range);
          if (!row) continue;
          if (identities.has(row.saleId)) throw new Error('ShopifyQL sales repeated a grouped row; results cannot be safely counted');
          identities.add(row.saleId);
          if (row.productIdentityStatus!=='unavailable' && !byVariant.has(row.variantId)) missingCatalog.add(row.variantId || row.sku || row.product);
          monthSales.push(row);
        }
        // An extra empty page is allowed at exactly the safety cap, proving that
        // a full last page was the end rather than silently accepting truncation.
        if (page.rows.length < pageSize) {complete = true; break;}
      }
      if (!complete) throw new Error(`Daily sales reached ${maxRowsPerMonth} rows; cannot certify completeness`);
    } catch (cause) {
      const error = new Error(`${shop.label || shop.key} ${range.month}: daily Shopify sales could not be read completely: ${cause.message}`, {cause});
      error.code = 'SHOPIFY_DAILY_SALES_INCOMPLETE';
      error.month = range.month;
      throw error;
    }
    sales.push(...monthSales);
    coverage[range.month] = {
      status: 'success', source: 'shopifyql_sales', start: range.start, end: range.end,
      costMetric:costsEnabled && monthSales.every(r=>r.costSource==='shopifyql_cost_of_goods_sold') ? 'cost_of_goods_sold' : null,
      financialMetrics: financialsEnabled ? ['netSales','grossSales','discounts'].filter(field=>monthSales.every(r=>Number.isFinite(r[field]))) : [],
      rows: monthSales.length, pages,
      quantityOrdered: monthSales.reduce((sum, row) => sum + row.quantityOrdered, 0),
      netUnits: monthSales.reduce((sum, row) => sum + row.netUnits, 0),
      unidentifiedProductRows: monthSales.filter(row=>row.productIdentityStatus==='unavailable').length,
      unidentifiedQuantityOrdered: monthSales.filter(row=>row.productIdentityStatus==='unavailable').reduce((sum,row)=>sum+row.quantityOrdered,0),
      unidentifiedNetUnits: monthSales.filter(row=>row.productIdentityStatus==='unavailable').reduce((sum,row)=>sum+row.netUnits,0),
    };
    onProgress({month:range.month,...coverage[range.month]});
  }
  if (missingCatalog.size) warnings.push(`${shop.label || shop.key}: ${missingCatalog.size} historical sales identities are absent from the current catalog; their Shopify sales were retained.`);
  const unidentified=sales.filter(row=>row.productIdentityStatus==='unavailable');
  if(unidentified.length) warnings.push(`${shop.label || shop.key}: ${unidentified.length} dated Shopify sales rows have no product identity. Their ordered/net metrics remain in vendor totals and are excluded from SKU inventory allocation.`);
  return {sales, coverage, warnings};
}
