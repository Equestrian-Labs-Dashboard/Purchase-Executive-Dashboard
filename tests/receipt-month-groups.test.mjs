import test from 'node:test';
import assert from 'node:assert/strict';
import {receiptGroups} from '../assets/js/purchaseCore.mjs';
const sku={store:'corro',vendor:'Supplier A',inventoryItemId:'item-01',variantId:'variant-01',sku:'SKU01',currency:'USD',retailCurrency:'USD',unitCost:10,retailPrice:15,cohortType:'receipt',dateBasis:'received',openingHistoryAvailable:true,allocationConfidence:'estimated_fifo',costBasis:'purchase_order_cost'};
const receipt=(date,units,sold)=>({...sku,receivedAt:date,cohortDate:date,unitsReceived:units,soldWithinDays:{30:sold,60:sold,90:sold}});
const ledger={...sku,month:'2026-07',unitsReceived:8,soldFromMonthReceipts:8,previousStockSold:10,orderedUnits:18,netItemsSold:18};
const meta={startDate:'2026-01-01',stores:{corro:{salesThrough:'2026-10-14',salesDailyCoverage:Object.fromEntries(Array.from({length:10},(_,i)=>{
 const m=`2026-${String(i+1).padStart(2,'0')}`;return [m,{status:'success',start:`${m}-01`,end:new Date(Date.UTC(2026,i+1,0)).toISOString().slice(0,10)}];
}))}}};
const filters={store:'corro',vendor:'all',category:'all',brand:'all',type:'month',period:'2026-07'};
const report=(rows,history=[ledger],m=meta)=>({receipts:rows,receiptMonthLedger:history,meta:m,asOf:'2026-10-14'});
test('Purchase month groups show 8 new receipts sold and 10 previous-stock sales, never 18 new',()=>{
 const g=receiptGroups(report([receipt('2026-07-01',8,8)]),filters)[0];
 assert.equal(g.units,8);assert.equal(g.soldInReceiptMonth,8);assert.equal(g.previousStockSold,10);assert.equal(g.totalOrderedMonth,18);
 assert.equal(g.windows[90].units,8);assert.equal(g.remaining90,0);
});
test('multiple dates in same month never duplicate a single SKU stock ledger',()=>{
 const g=receiptGroups(report([receipt('2026-07-01',5,3),receipt('2026-07-20',7,5)],
 [{...ledger,unitsReceived:12,soldFromMonthReceipts:8,previousStockSold:10}]),filters)[0];
 assert.equal(g.units,12);assert.equal(g.soldInReceiptMonth,8);assert.equal(g.previousStockSold,10);
 assert.equal(g.windows[30].start,'2026-07-01');assert.equal(g.windows[30].units,8);
});
test('coverage gap, omitted baseline and cross-store rows cannot fabricate previous stock',()=>{
 const broken=structuredClone(meta);delete broken.stores.corro.salesDailyCoverage['2026-04'];
 assert.equal(receiptGroups(report([receipt('2026-07-01',8,8)],[ledger],broken),filters)[0].soldInReceiptMonth,null);
 assert.equal(receiptGroups(report([receipt('2026-07-01',8,8)],[{...ledger,openingHistoryAvailable:false}]),filters)[0].previousStockSold,null);
 assert.equal(receiptGroups(report([receipt('2026-07-01',8,8)],[{...ledger,store:'cavali'}]),filters)[0].soldInReceiptMonth,null);
});

test('Purchase 30/60/90 checkpoints are N/A when baseline is not confirmed',()=>{
 const unverifiable={...receipt('2026-07-01',8,8),openingHistoryAvailable:false};
 const group=receiptGroups(report([unverifiable]),filters)[0];
 assert.equal(group.windows[30].status,'unavailable');assert.equal(group.windows[60].units,null);
 assert.equal(group.remaining90,null);
});
