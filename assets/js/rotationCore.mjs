// Pure calculation helpers for Inventory Tracking. Dates use UTC calendar days,
// avoiding local time-zone shifts for Shopify's YYYY-MM-DD business dates.
export function dateDaysBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.floor((b - a) / 86400000) : null;
}

export const reportMonth = (date) => String(date || '').slice(0, 7);
export const reportQuarter = (date) => {
  const month = Number(String(date || '').slice(5, 7));
  return month >= 1 && month <= 12 ? `${String(date).slice(0, 4)}-Q${Math.ceil(month / 3)}` : '';
};
export const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function isReceivedCohort(row) {
  return String(row?.sourceReason||'').toLowerCase()!=='restock' && row?.dateBasis === 'received' && row?.cohortType === 'receipt' && /^\d{4}-\d{2}-\d{2}$/.test(row?.receivedAt || row?.cohortDate || '');
}
export function isObservedRestockCohort(row) {
  const reason=String(row?.sourceReason||'').toLowerCase().replace(/[\s_-]/g,'');
  return !['restock','return','returned','customerreturn','returnrestock','customerrestock'].includes(reason) && row?.dateBasis === 'observed_stock_increase' && row?.cohortType === 'restock' && /^\d{4}-\d{2}-\d{2}$/.test(row?.cohortDate || '');
}
export function inPeriod(row, type, period) {
  if (period === 'all') return true;
  const date = row.receivedAt || row.cohortDate;
  if (type === 'month') return reportMonth(date) === period;
  if (type === 'quarter') return reportQuarter(date) === period;
  if (type === 'ytd') return date.slice(0, 4) === period;
  return false;
}
export function checkpoint(row, days, asOf) {
  const age = dateDaysBetween(row.receivedAt || row.cohortDate, asOf);
  const values = row.soldWithinDays;
  // A monthly-offset snapshot cannot be relabeled as an exact 30/60/90-day result.
  if (!values || !Object.prototype.hasOwnProperty.call(values, String(days))) return {status: 'unavailable', units: null, pct: null};
  // asOf is the last complete included reporting day (store timezone).
  if (age === null || age < days - 1) {
    const soFarUnits = Math.min(number(row.unitsReceived), Math.max(0, number(values[String(days)])));
    return {status:'pending', units:null, pct:null, soFarUnits, soFarPct:number(row.unitsReceived)>0?100*soFarUnits/number(row.unitsReceived):null};
  }
  const units = Math.min(number(row.unitsReceived), Math.max(0, number(values[String(days)])));
  return {status: 'ready', units, pct: number(row.unitsReceived) > 0 ? 100 * units / number(row.unitsReceived) : null};
}
export function summarizeVendorReceipts(rows, asOf, {observed=false}={}) {
  const groups = new Map();
  for (const r of rows.filter(observed==='all'?(r=>isReceivedCohort(r)||isObservedRestockCohort(r)):observed?isObservedRestockCohort:isReceivedCohort)) {
    const date = r.receivedAt || r.cohortDate;
    const key = JSON.stringify([r.store, r.vendor || 'Unknown', date, r.cohortType]);
    if (!groups.has(key)) groups.set(key, {store: r.store, vendor: r.vendor || 'Unknown', date, cohortType:r.cohortType, rows: []});
    groups.get(key).rows.push(r);
  }
  return [...groups.values()].map((g) => {
    const units = g.rows.reduce((a, r) => a + number(r.unitsReceived), 0);
    const unpriced = g.rows.filter((r) => !Number.isFinite(Number(r.unitCost)) || number(r.unitCost) <= 0);
    const cost = g.rows.reduce((a, r) => a + (number(r.unitCost) > 0 ? number(r.unitsReceived) * number(r.unitCost) : 0), 0);
    const listRevenueAvailable = g.rows.every((r) => number(r.retailPrice) > 0 && number(r.unitCost) > 0);
    const currentMarkupPct = listRevenueAvailable && cost > 0
      ? (g.rows.reduce((a,r) => a + number(r.unitsReceived) * number(r.retailPrice),0) / cost - 1) * 100
      : null;
    const checkpoints = {};
    for (const days of [30, 60, 90]) {
      const values = g.rows.map((r) => checkpoint(r, days, asOf));
      const status = values.some((v) => v.status === 'unavailable') ? 'unavailable'
        : values.some((v) => v.status === 'pending') ? 'pending' : 'ready';
      const sold = status === 'ready' ? values.reduce((a, v) => a + number(v.units), 0) : null;
      const soFarUnits = status === 'pending' ? values.reduce((a, v) => a + number(v.soFarUnits ?? v.units), 0) : null;
      checkpoints[days] = {status, units:sold, pct:status==='ready'&&units?sold/units*100:null,
        soFarUnits, soFarPct:status==='pending'&&units?soFarUnits/units*100:null};
    }
    return {...g, units, cost: unpriced.length === g.rows.length ? null : cost,
      costIsPartial: unpriced.length > 0, currentMarkupPct, checkpoints,
      costIsHistorical: g.rows.every((r) => r.costBasis === 'manual_recorded_cost' || r.costBasis === 'purchase_order_cost'),
      allocationMethod: 'FIFO estimate including estimated opening stock'};
  }).sort((a, b) => b.units - a.units || a.vendor.localeCompare(b.vendor) || a.date.localeCompare(b.date));
}

export function summarizeVendorHistory(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.store, r.vendor || 'Unknown']);
    if (!groups.has(key)) groups.set(key, {store: r.store, vendor: r.vendor || 'Unknown', opening: 0, sold: 0, closing: 0, change: 0, positiveAdjustments: 0});
    const g = groups.get(key);
    g.opening += number(r.startingUnits);
    g.sold += number(r.unitsSold);
    g.closing += number(r.endingUnits);
    g.change += number(r.netInventoryChange);
    g.positiveAdjustments += number(r.positiveAdjustments);
  }
  return [...groups.values()].sort((a, b) => b.sold - a.sold || a.vendor.localeCompare(b.vendor));
}
