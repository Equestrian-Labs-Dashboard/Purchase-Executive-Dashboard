import {normalizeInventoryEvent} from './shopify-native-receipts.mjs';
import {allocateDatedCohorts} from './cohort-allocation.mjs';

// Repair already-downloaded source files as well as future syncs. Never change
// monthly Shopify history, raw dated sales, costs or the current stock snapshot.
export function normalizeReceiptData(source) {
  const known=new Map();
  for(const row of [...(source.cohortInputs||[]),...(source.cohorts||[]),...(source.observedRestockCohorts||[]),...(source.customerRestocks||[]),...(source.nativeRestockEvents||[])]) {
    const normalized=normalizeInventoryEvent(row);
    const key=normalized.receiptId || JSON.stringify([normalized.store,normalized.variantId,normalized.cohortDate,normalized.source,normalized.sourceReason]);
    known.set(key,normalized);
  }
  const all=[...known.values()];
  const customerRestocks=all.filter(row=>row.cohortType==='return');
  const eligible=all.filter(row=>row.cohortType==='receipt'&&row.dateBasis==='received' || row.cohortType==='restock'&&row.dateBasis==='observed_stock_increase');
  const stores=[...new Set(eligible.map(row=>row.store))];
  const cohorts=[];
  for(const store of stores) {
    const info=source.meta?.stores?.[store] || {};
    const allocation=allocateDatedCohorts({shop:{key:store,label:info.label||store},receipts:eligible.filter(row=>row.store===store),
      inventoryReturns:customerRestocks.filter(row=>row.store===store),sales:(source.sales||[]).filter(row=>row.store===store),
      catalog:(source.currentInventory||[]).filter(row=>row.store===store),openingHistory:source.monthlyInventory||[],startDate:source.meta?.startDate||'2026-06-01'});
    for(const row of allocation.cohorts) {
      row.salesMetric=info.salesMetric||'quantity_ordered';row.salesSource=info.salesSource||'';row.salesThrough=info.salesThrough||'';
      const status=info.nativeDailyCoverage?.[row.cohortMonth]?.status;
      if(row.cohortType==='restock' && ['error','inconsistent'].includes(status)){row.soldWithinDays={};row.allocationConfidence='incomplete_daily_adjustments';}
      cohorts.push(row);
    }
  }
  return {...source,meta:{...source.meta,receiptClassificationVersion:2},customerRestocks,
    nativeRestockEvents:(source.nativeRestockEvents||[]).map(normalizeInventoryEvent),
    cohortInputs:(source.cohortInputs||[]).map(normalizeInventoryEvent).filter(row=>row.cohortType==='receipt'),
    cohorts:cohorts.filter(row=>row.cohortType==='receipt'),observedRestockCohorts:cohorts.filter(row=>row.cohortType==='restock')};
}
