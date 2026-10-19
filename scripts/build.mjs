import fs from 'node:fs/promises';
import path from 'node:path';
import {readInventorySource} from './inventory-source.mjs';
import {normalizeReceiptData} from './normalize-receipt-data.mjs';
const root=process.cwd(),out=path.join(root,'dist');
const raw=await readInventorySource({root}),source=normalizeReceiptData(raw);
// Purchase is CORRO ONLY. Inventory and the shared Shopify extractor still carry
// both stores; never change their independent source or credentials.
const isCorro=row=>row.store==='corro';
if(!source.meta?.stores?.corro)throw Error('Corro source is absent; refusing to publish another store as Corro');
const byId=new Map((source.currentInventory||[]).map(r=>[`${r.store}|${r.variantId}`,r]));
const select=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
const enrich=row=>({...row,brand:row.brand||byId.get(`${row.store}|${row.variantId}`)?.brand||'',currency:row.currency||byId.get(`${row.store}|${row.variantId}`)?.currency||'',retailCurrency:row.retailCurrency||byId.get(`${row.store}|${row.variantId}`)?.currency||'',category:row.category||byId.get(`${row.store}|${row.variantId}`)?.category||'Uncategorized'});
const receiptKeys=['store','vendor','brand','category','currency','retailCurrency','sku','product','variant','variantId','inventoryItemId','unitsReceived','unitCost','retailPrice','costBasis','cohortType','dateBasis','receivedAt','cohortDate','soldWithinDays','openingHistoryAvailable','allocationConfidence','salesThrough'];
const salesKeys=['store','vendor','brand','category','currency','soldAt','quantityOrdered','netUnits','costOfGoodsSold','costSource','netSales','grossSales','discounts','netSalesSource','grossSalesSource','discountsSource'];
const meta={generatedAt:source.meta.generatedAt,startDate:source.meta.startDate,stores:{corro:select(source.meta.stores.corro,['label','salesThrough','salesDailyCoverage','receiptPermissions','purchaseOrderError','shipmentError','nativeDailyCoverage','supplementaryUnattributedUnits','supplementaryMissingCatalogUnits','supplementaryMatchedReceiptUnits','supplementaryArchiveMonths'])}};
const dates=Object.values(meta.stores).map(s=>s.salesThrough).filter(Boolean).sort();
if(!dates.length)throw Error('Export has no complete reporting date');
// Compact monthly vendor+category history supports the real Monthly Rotation
// KPI. Do not fetch a second Shopify dataset and never add monthly snapshots
// to produce an on-hand stock count.
const monthlyMap=new Map();
for(const row of (source.monthlyInventory||[]).filter(isCorro)) {
  const identity=byId.get(`${row.store}|${row.variantId}`)||{};
  const brand=row.brand||identity.brand||'Unspecified';
  const category=row.category||identity.category||'Uncategorized';
  const vendor=row.vendor||'Unknown';
  const key=JSON.stringify([row.month,vendor,brand,category]);
  if(!monthlyMap.has(key))monthlyMap.set(key,{store:'corro',month:row.month,vendor,brand,category,startingUnits:0,endingUnits:0,unitsSold:0});
  const out=monthlyMap.get(key);
  for(const field of ['startingUnits','endingUnits','unitsSold'])out[field]+=Number(row[field])||0;
}
const report={version:2,meta,asOf:dates[0],receipts:(source.cohorts||[]).filter(isCorro).map(r=>select(enrich(r),receiptKeys)),
  observed:(source.observedRestockCohorts||[]).filter(isCorro).map(r=>select(enrich(r),receiptKeys)),
  customerReturnCount:(source.customerRestocks||[]).filter(isCorro).length,
  sales:(source.sales||[]).filter(isCorro).map(r=>select(enrich(r),salesKeys)),
  catalog:(source.currentInventory||[]).filter(isCorro).map(r=>select(enrich(r),['store','vendor','brand','category','currency','variantId','sku','currentUnits','unitCost','retailPrice'])),
  receiptMonthLedger:(source.receiptMonthLedger||[]).filter(isCorro).map(r=>select(enrich(r),['store','vendor','brand','category','month','inventoryItemId','variantId','sku','product','unitsReceived','soldFromMonthReceipts','previousStockSold','openingStockSold','olderReceiptSold','customerReturnStockSold','observedAdjustmentStockSold','unattributedSales','orderedUnits','netItemsSold','openingHistoryAvailable','allocationConfidence'])),
  monthly:[...monthlyMap.values()]};
// Validate the source before replacing the previous output.
if(path.dirname(out)!==root||(await fs.lstat(out).catch(()=>null))?.isSymbolicLink())throw Error('Unsafe build output');
await fs.rm(out,{recursive:true,force:true});await fs.mkdir(path.join(out,'data'),{recursive:true});
for(const name of ['index.html','site-config.json','access-config.json'])await fs.copyFile(path.join(root,name),path.join(out,name));
await fs.cp(path.join(root,'assets'),path.join(out,'assets'),{recursive:true});
// Shard daily sales/catalog; include only compact monthly vendor movement, never the raw heavy monthly history.
const manifest={version:1,generatedAt:meta.generatedAt,files:[]};
for(const [key,rows] of [['base',[{...report,sales:undefined,catalog:undefined}]],['sales',report.sales],['catalog',report.catalog]]) {
  for(let i=0;i<rows.length;i+=2000){const file=`purchase_${key}_${i/2000}.json`;await fs.writeFile(path.join(out,'data',file),JSON.stringify(rows.slice(i,i+2000)));manifest.files.push({key,file});}
}
await fs.writeFile(path.join(out,'data/manifest.json'),JSON.stringify(manifest));
await fs.writeFile(path.join(out,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n/data/*\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: no-cache\n');
console.log(`Purchase built: ${report.receipts.length} confirmed receipts, ${report.sales.length} daily sales rows. Source ${meta.generatedAt}.`);
