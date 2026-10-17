import fs from 'node:fs/promises';
import path from 'node:path';
import {readInventorySource} from './inventory-source.mjs';
import {normalizeReceiptData} from './normalize-receipt-data.mjs';
const root=process.cwd(),out=path.join(root,'dist');
const raw=await readInventorySource({root}),source=normalizeReceiptData(raw);
const byId=new Map((source.currentInventory||[]).map(r=>[`${r.store}|${r.variantId}`,r]));
const select=(row,keys)=>Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]));
const enrich=row=>({...row,brand:row.brand||byId.get(`${row.store}|${row.variantId}`)?.brand||'',currency:row.currency||byId.get(`${row.store}|${row.variantId}`)?.currency||'',retailCurrency:row.retailCurrency||byId.get(`${row.store}|${row.variantId}`)?.currency||''});
const receiptKeys=['store','vendor','brand','currency','retailCurrency','sku','product','variant','variantId','unitsReceived','unitCost','retailPrice','costBasis','cohortType','dateBasis','receivedAt','cohortDate','soldWithinDays','openingHistoryAvailable','allocationConfidence','salesThrough'];
const salesKeys=['store','vendor','brand','currency','soldAt','quantityOrdered','netUnits','costOfGoodsSold','costSource','netSales','grossSales','discounts','netSalesSource','grossSalesSource','discountsSource'];
const meta={generatedAt:source.meta.generatedAt,startDate:source.meta.startDate,stores:Object.fromEntries(Object.entries(source.meta.stores).map(([key,s])=>[key,select(s,['label','salesThrough','salesDailyCoverage','receiptPermissions','purchaseOrderError','shipmentError','nativeDailyCoverage'])]))};
const dates=Object.values(meta.stores).map(s=>s.salesThrough).filter(Boolean).sort();
if(!dates.length)throw Error('Export has no complete reporting date');
const report={version:1,meta,asOf:dates[0],receipts:(source.cohorts||[]).map(r=>select(enrich(r),receiptKeys)),observed:(source.observedRestockCohorts||[]).map(r=>select(enrich(r),receiptKeys)),customerReturnCount:(source.customerRestocks||[]).length,
  sales:(source.sales||[]).map(r=>select(enrich(r),salesKeys)),catalog:(source.currentInventory||[]).map(r=>select(r,['store','vendor','brand','currency','currentUnits','unitCost','retailPrice']))};
// Validate the source before replacing the previous output.
if(path.dirname(out)!==root||(await fs.lstat(out).catch(()=>null))?.isSymbolicLink())throw Error('Unsafe build output');
await fs.rm(out,{recursive:true,force:true});await fs.mkdir(path.join(out,'data'),{recursive:true});
for(const name of ['index.html','site-config.json','access-config.json'])await fs.copyFile(path.join(root,name),path.join(out,name));
await fs.cp(path.join(root,'assets'),path.join(out,'assets'),{recursive:true});
// Shard daily sales/catalog; browser never needs the heavy monthly history.
const manifest={version:1,generatedAt:meta.generatedAt,files:[]};
for(const [key,rows] of [['base',[{...report,sales:undefined,catalog:undefined}]],['sales',report.sales],['catalog',report.catalog]]) {
  for(let i=0;i<rows.length;i+=2000){const file=`purchase_${key}_${i/2000}.json`;await fs.writeFile(path.join(out,'data',file),JSON.stringify(rows.slice(i,i+2000)));manifest.files.push({key,file});}
}
await fs.writeFile(path.join(out,'data/manifest.json'),JSON.stringify(manifest));
await fs.writeFile(path.join(out,'_headers'),'/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: same-origin\n/data/*\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: no-cache\n');
console.log(`Purchase built: ${report.receipts.length} confirmed receipts, ${report.sales.length} daily sales rows. Source ${meta.generatedAt}.`);
