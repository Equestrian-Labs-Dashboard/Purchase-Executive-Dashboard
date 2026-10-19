import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writePortableInventory, validatePortableInventory} from '../scripts/export-portable-inventory.mjs';
import {importManualShopifyHistory} from '../scripts/import-manual-shopify-history.mjs';

const headerAdj='Day,Product variant ID,Product variant SKU,Inventory change reason,Inventory state,Reference document URI,Inventory adjustment change\n';
const headerSales='Day,Product variant ID,Product variant SKU,Quantity ordered,Net items sold,Net sales,Cost of goods sold\n';
const headerStock='Product variant ID,Starting inventory units,Inventory units sold,Ending inventory units,Ending inventory value\n';
test('manual ShopifyQL CSV import respects supplier evidence, preserves Cavali and rebuilds source with no Actions',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'shopify-import-test-'));
 try {
  const names=['corro','cavali'];const coverage={status:'success',source:'shopifyql_sales',start:'2026-07-01',end:'2026-07-31'};
  const shop={ok:true,status:'synced',label:'Shop',salesThrough:'2026-07-31',nativeDailyCoverage:{'2026-07':{status:'success'}},salesDailyCoverage:{'2026-07':coverage}};
  const initial={meta:{status:'ok',generatedAt:'2026-10-15T00:00:00Z',startDate:'2026-07-01',historyStartDate:'2026-07-01',salesSyncFrom:'2026-07-01',stores:{corro:{...shop},cavali:{...shop}}},
   currentInventory:names.map(store=>({store,variantId:`gid://shopify/ProductVariant/${store==='corro'?11:22}`,inventoryItemId:`gid://shopify/InventoryItem/${store==='corro'?111:222}`,sku:'S1',vendor:'Vendor',product:'Product',tracked:true,requiresShipping:true,eligibleForInventory:true,historicalPhysicalItem:true,unitCost:2,retailPrice:6})),
   monthlyInventory:names.map(store=>({store,month:'2026-07',variantId:`gid://shopify/ProductVariant/${store==='corro'?11:22}`,startingUnits:4,unitsSold:1,endingUnits:3})),sales:names.map(store=>({store,soldAt:'2026-07-05',variantId:`gid://shopify/ProductVariant/${store==='corro'?11:22}`,units:1})),monthlyAdjustments:[],cohorts:[],cohortInputs:[]};
  await writePortableInventory(initial,{outputDir:path.join(root,'data','shopify-export'),validate:false});
  const csvDir=path.join(root,'csv');await fs.mkdir(csvDir);
  await fs.writeFile(path.join(csvDir,'CORRO_2026-07_ADJUSTMENTS.csv'),headerAdj+'2026-07-12,11,S1,purchase_order_received,available,gid://shopify/PurchaseOrder/400,5\n2026-07-13,11,S1,manual_adjustment,available,,20\n2026-07-14,11,S1,correction,available,,100\n');
  await fs.writeFile(path.join(csvDir,'CORRO_2026-07_SALES.csv'),headerSales+'2026-07-15,11,S1,6,5,30,10\n');
  await fs.writeFile(path.join(csvDir,'CORRO_2026-07_STOCK.csv'),headerStock+'11,10,6,9,18\n');
  const output=path.join(root,'tmp.json');const res=await importManualShopifyHistory({root,store:'corro',months:['2026-07'],csvDir,output,through:'2026-07-31'});
  const next=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(res.results[0].verifiedPOUnits,5);
  assert.equal(res.results[0].manualPositiveAvailableUnits,20);
  assert.equal(res.results[0].correctionPositiveAvailableUnits,100);
  assert.equal(next.cohortInputs.length,1);assert.equal(next.cohortInputs[0].unitsReceived,5);
  assert.equal(next.sales.find(x=>x.store==='corro').quantityOrdered,6);
  assert.equal(next.monthlyInventory.find(x=>x.store==='corro').startingUnits,10);
  assert.equal(next.currentInventory.find(x=>x.store==='corro').currentUnits,9);
  assert.equal(next.monthlyInventory.find(x=>x.store==='corro').positiveAdjustments,20);
  assert.equal(next.monthlyInventory.find(x=>x.store==='corro').correctionUnits,100);
  assert.equal(next.sales.filter(x=>x.store==='cavali').length,1);
  assert.doesNotThrow(()=>validatePortableInventory(next));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
