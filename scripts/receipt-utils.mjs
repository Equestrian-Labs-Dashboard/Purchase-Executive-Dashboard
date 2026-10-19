// Strict parsing for real supplier receipts. Reject ambiguous or incomplete rows;
// never turn monthly stock adjustments or purchase-order dates into receipts.
export const REQUIRED_COLUMNS = ['receipt_id','store','received_at','sku','units_received','unit_cost','currency','product','vendor','category'];
export const VALID_STORES = new Set(['corro','cavali']);

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

export function parseVerifiedReceiptsCsv(csv, {startDate = '2026-06-01'} = {}) {
  const allRows = parseCsv(csv);
  const dataRows = allRows.map((cells, i) => ({cells, number:i + 1}))
    .filter(({cells}) => cells.some(c => String(c).trim()) && !String(cells[0] || '').trim().startsWith('#'));
  if (!dataRows.length) throw new Error('No CSV header found.');
  const headers = dataRows[0].cells.map(h => String(h).trim().toLowerCase());
  for (const required of REQUIRED_COLUMNS.slice(0, 7)) {
    if (!headers.includes(required)) throw new Error(`Required CSV column missing: ${required}`);
  }
  const records = [], errors = [], seen = new Set();
  for (const {cells,number} of dataRows.slice(1)) {
    if (cells.length > headers.length) { errors.push(`Line ${number}: too many columns (check unquoted commas).`); continue; }
    const r = Object.fromEntries(headers.map((h,i) => [h, String(cells[i] ?? '').trim()]));
    const store = (r.store || '').toLowerCase();
    if (!VALID_STORES.has(store)) errors.push(`Line ${number}: store must be corro or cavali.`);
    if (!r.receipt_id) errors.push(`Line ${number}: receipt_id is required (actual delivery document or unique line ID).`);
    if (!validDate(r.received_at)) errors.push(`Line ${number}: received_at must be a real YYYY-MM-DD date.`);
    if (r.received_at && r.received_at < startDate) errors.push(`Line ${number}: received_at precedes reporting start ${startDate}.`);
    if (!r.sku) errors.push(`Line ${number}: sku is required for matching dated Shopify sales.`);
    const units = Number(r.units_received);
    if (!Number.isSafeInteger(units) || units <= 0) errors.push(`Line ${number}: units_received must be a positive integer.`);
    const unitCost = r.unit_cost === '' ? null : Number(r.unit_cost);
    if (unitCost !== null && (!Number.isFinite(unitCost) || unitCost < 0)) errors.push(`Line ${number}: unit_cost must be a nonnegative amount or blank if unknown.`);
    if (r.currency && !/^[A-Z]{3}$/i.test(r.currency)) errors.push(`Line ${number}: currency must have three letters (e.g. USD).`);
    const signature = `${store}|${r.receipt_id}|${r.received_at}|${r.sku.toLowerCase()}`;
    if (seen.has(signature)) errors.push(`Line ${number}: duplicate receipt_id + date + SKU + store; combine its units on one line.`);
    seen.add(signature);
    if (VALID_STORES.has(store) && validDate(r.received_at) && r.sku && Number.isSafeInteger(units) && units > 0) {
      records.push({...r,store,units_received:units,unit_cost:unitCost,currency:(r.currency || 'USD').toUpperCase(),lineNumber:number});
    }
  }
  if (errors.length) throw new Error(`Supplier receipts CSV failed validation:\n${errors.slice(0,20).join('\n')}${errors.length>20?`\n... and ${errors.length-20} more errors.`:''}`);
  return records;
}

export function validateReceiptSource(rows) {
  if (!Array.isArray(rows)) throw new TypeError('Rows must be an array');
  return rows.filter(r => r && r.dateBasis === 'received' && r.cohortType === 'receipt'
    && validDate(r.receivedAt || r.cohortDate) && Number(r.unitsReceived) > 0);
}
