import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeSkuSales,stockMovementSales} from '../assets/js/stockMovementSales.mjs';
const V='gid://shopify/ProductVariant/111', V2='gid://shopify/ProductVariant/222';
const add=(date,units=10,id=V,more={})=>({store:'corro',vendor:'Vendor A',brand:'',category:'Tack',variantId:id,sku:id===V?'SKU-A':'SKU-B',cohortDate:date,unitsReceived:units,unitCost:5,retailPrice:10,currency:'USD',sourceReason:'manual_adjustment',notSupplierProof:true,...more});
const sale=(day,units=1,id=V)=>({store:'corro',variantId:id,soldAt:day,netUnits:units,quantityOrdered:Math.max(units,0)});
const filters=(period='2026-07',vendor='all')=>({store:'corro',vendor,brand:'all',category:'all',type:'month',period});
const info={stores:{corro:{salesThrough:'2026-10-19',salesDailyCoverage:Object.fromEntries(['2026-07','2026-08','2026-09','2026-10'].map(m=>[m,{status:'success',start:m+'-01',end:m==='2026-10'?'2026-10-19':m==='2026-09'?'2026-09-30':m==='2026-08'?'2026-08-31':'2026-07-31'}]))}}};
const calc=(evidence,sales,period='2026-07',meta=info)=>stockMovementSales({evidence,sales,meta,asOf:'2026-10-19',filters:filters(period)});
test('July 15 and July 22 increases do NOT duplicate a SKU order, negative reversals subtract',()=>{
 const rows=calc([add('2026-07-15',7),add('2026-07-22',3)], [sale('2026-07-16',3),sale('2026-07-23',4),sale('2026-08-01',2),sale('2026-08-10',-1)]);
 assert.equal(rows.length,1);assert.equal(rows[0].units,10);
 assert.equal(rows[0].windows[30].units,8); // 3+4+2-1 counted only once
 assert.equal(rows[0].windows[30].status,'complete');
 assert.equal(rows[0].catalogMarkup,100);
 assert.equal(rows[0].currentCost,50);
});
test('a new August stock change takes later sales; July and August are nonoverlapping',()=>{
 const evidence=[add('2026-07-15',10),add('2026-08-05',4)];
 const sales=[sale('2026-07-20',2),sale('2026-08-06',3)];
 assert.equal(calc(evidence,sales,'2026-07')[0].windows[90].units,2);
 assert.equal(calc(evidence,sales,'2026-08')[0].windows[90].units,3);
});
test('sales-only vendor, Cavali, corrections, transfers, customer returns never create incoming rows',()=>{
 const evidence=[add('2026-07-05',7,V,{sourceReason:'correction'}),add('2026-07-05',8,V,{store:'cavali'}),add('2026-07-05',7,V,{notSupplierProof:false}),add('2026-07-05',2,V,{vendor:'Vendor Valid'})];
 const rows=calc(evidence,[sale('2026-07-10',12)]);
 assert.equal(rows.length,1);assert.equal(rows[0].vendor,'Vendor Valid');assert.equal(rows[0].units,2);
 assert.equal(rows[0].windows[30].units,12);
 assert.equal(rows[0].windows[30].ratio,600); // explicitly NOT sell-through
});
test('same-day orders included, but cannot establish intra-day order before/after receipt',()=>{
 const row=calc([add('2026-07-15')],[sale('2026-07-15',5)])[0];
 assert.equal(row.windows[30].units,5);
});
test('pending 30/60/90 window still exposes net orders so far and reports pending',()=>{
 const row=calc([add('2026-10-08')],[sale('2026-10-10',2)],'2026-10')[0];
 assert.equal(row.windows[30].units,2);assert.equal(row.windows[30].status,'pending');
 assert.equal(row.windows[90].status,'pending');
});
test('missing date-level coverage shows N/A rather than fabricated zero',()=>{
 const row=calc([add('2026-07-08')],[sale('2026-07-15',3)],'2026-07',{stores:{corro:{salesThrough:'2026-10-19',salesDailyCoverage:{}}}})[0];
 assert.equal(row.windows[30].units,null);assert.equal(row.windows[30].status,'unavailable');
});
test('sales only match their exact variant ID and absent cost does not become zero',()=>{
 const row=calc([add('2026-07-15',3)],[sale('2026-07-17',4,V2),sale('2026-07-18',2)])[0];
 assert.equal(row.windows[30].units,2);
 const missing=calc([add('2026-07-15',3,V,{unitCost:null})],[sale('2026-07-18',2)])[0];
 assert.equal(missing.currentCost,null);
});
test('cached day/SKU merges duplicates; live Shopify refresh overrides cached day/SKU',()=>{
 const imported=[sale('2026-07-08',1),sale('2026-07-08',2)];
 const live=[sale('2026-07-08',4)];
 assert.equal(mergeSkuSales([],imported).length,1);
 assert.equal(mergeSkuSales([],imported)[0].netUnits,3);
 assert.equal(mergeSkuSales(live,imported)[0].netUnits,4);
});
