import test from 'node:test';
import assert from 'node:assert/strict';
import {observedStockGroups} from '../assets/js/stockAdditionsView.mjs';
const row=(changes={})=>({store:'corro',vendor:'Vendor A',category:'Saddles',brand:'Brand A',cohortDate:'2026-07-15',unitsReceived:4,variantId:'gid://shopify/ProductVariant/123',unitCost:12,currency:'USD',sourceReason:'manual_adjustment',notSupplierProof:true,...changes});
const select={store:'corro',vendor:'all',category:'all',brand:'all',type:'month',period:'2026-07'};
test('only date-filtered positive stock entries from Corro, never sales-only vendors or Cavali',()=>{
 const entries=[row(),row({store:'cavali',vendor:'Cavali Vendor',variantId:'4'}),row({vendor:'Sales only vendor',sourceReason:'purchase',variantId:'9'}),row({vendor:'Correction vendor',sourceReason:'correction'}),row({cohortDate:'2026-08-01',vendor:'August Vendor'})];
 const r=observedStockGroups(entries,select,'2026-10-19');
 assert.equal(r.length,1);assert.equal(r[0].units,4);assert.equal(r[0].vendor,'Vendor A');assert.deepEqual(r[0].dates,['2026-07-15']);
});
test('observed additions can display current catalog cost estimate but cannot claim invoice cost',()=>{
 const r=observedStockGroups([row(),row({variantId:'gid://shopify/ProductVariant/456',cohortDate:'2026-07-22',unitsReceived:2,unitCost:15})],select,'2026-10-19');
 assert.equal(r.length,1);assert.equal(r[0].units,6);assert.equal(r[0].skuCount,2);assert.equal(r[0].estimatedCurrentCost,78);
 assert.deepEqual(r[0].dates,['2026-07-15','2026-07-22']);
});
test('missing current cost or mixed currencies hides estimate, never treats missing data as zero',()=>{
 const r=observedStockGroups([row(),row({variantId:'gid://shopify/ProductVariant/456',unitCost:null})],select,'2026-10-19');
 assert.equal(r[0].units,8);assert.equal(r[0].pricedUnits,4);assert.equal(r[0].estimatedCurrentCost,null);
 const mixed=observedStockGroups([row(),row({currency:'EUR'})],select,'2026-10-19');assert.equal(mixed[0].estimatedCurrentCost,null);
});
test('future-dated entries are excluded even if the monthly period contains them',()=>{
 const r=observedStockGroups([row({cohortDate:'2026-07-26'}),row({cohortDate:'2026-07-11'})],select,'2026-07-20');assert.equal(r[0].units,4);
});
