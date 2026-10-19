/**
 * Combine ShopifyQL CSV exports with an existing synced source, without Shopify
 * credentials or GitHub Actions.  ONLY a Shopify PO-received event is treated as
 * supplier inventory received. Positive manual/correction adjustments are not.
 * The source keeps the other stores and untouched reporting months intact.
 *
 * Usage:
 *   node scripts/import-manual-shopify-history.mjs --store corro \
 *     --months 2026-07,2026-08,2026-09,2026-10 --csv-dir PATH \
 *     --output /tmp/corro-source.json --through 2026-10-19
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {readInventorySource} from './inventory-source.mjs';
import {convertShopifyQlCsv, parseCsv} from './shopifyql-csv-import.mjs';

const allowedStores=new Set(['corro','cavali']);
const keysStock=['Product variant ID','Starting inventory units','Inventory units sold','Ending inventory units','Ending inventory value'];
const keysSales=['Day','Product variant ID','Product variant SKU','Quantity ordered','Net items sold','Net sales','Cost of goods sold'];
const keysAdjustments=['Day','Product variant ID','Product variant SKU','Inventory change reason','Inventory state','Reference document URI','Inventory adjustment change'];
const validDay=d=>/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d)&&!Number.isNaN(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const money=(v,k)=>{const s=String(v??'').trim().replaceAll(',','');if(!s)return null;if(!/^-?\d+(?:\.\d+)?$/.test(s))throw Error(`Invalid numeric ${k}: ${v}`);const n=Number(s);if(!Number.isFinite(n))throw Error(`Invalid ${k}: ${v}`);return n;};
const integer=(v,k)=>{const n=money(v,k);if(n===null||!Number.isSafeInteger(n))throw Error(`Expected integer ${k}: ${v}`);return n;};
function parseRequired(content,headers,file){const r=parseCsv(content);for(const h of headers)if(!r.header.includes(h))throw Error(`${file}: missing ${h}`);return r.rows;}
const getId=r=>{const raw=String(r?.['Product variant ID']||'').trim();if(!raw)return '';if(!/^(?:\d+|gid:\/\/shopify\/ProductVariant\/\d+)$/.test(raw))throw Error('Invalid product variant id: '+raw);return raw.split('/').at(-1);};
const gid=id=>id?`gid://shopify/ProductVariant/${id}`:'';
const q=id=>String(id||'').split('/').at(-1);
const monthMatches=(day,month,label)=>{if(!validDay(day)||!day.startsWith(month))throw Error(`${label}: date ${day} not in ${month}`);};

export async function importManualShopifyHistory({root=process.cwd(),store,months,csvDir,output,through}) {
 if(!allowedStores.has(store))throw Error('Unknown store: '+store);
 if(!Array.isArray(months)||!months.length||months.some(x=>!/^2026-(0[1-9]|1[0-2])$/.test(x)))throw Error('Expected --months 2026-07,...');
 if(new Set(months).size!==months.length)throw Error('Duplicate month');
 if(!validDay(through))throw Error('Provide valid --through YYYY-MM-DD to mark the latest requested export date');
 const source=await readInventorySource({root});
 const catalog=new Map((source.currentInventory||[]).filter(x=>x.store===store && x.variantId).map(x=>[q(x.variantId),x]));
 const historical=new Map((source.monthlyInventory||[]).filter(x=>x.store===store&&x.variantId).map(x=>[q(x.variantId),x]));
 const dates=new Set(months);
 const stockRows=[],saleRows=[],adjustmentRows=[],addedReceipts=[];
 const stats=[],coverageSales={...source.meta?.stores?.[store]?.salesDailyCoverage},coverageAdj={...source.meta?.stores?.[store]?.nativeDailyCoverage};
 let latestStock=new Map();
 for(const month of months.slice().sort()){
  const base=`${store.toUpperCase()}_${month}`;
  const files=await Promise.all(['ADJUSTMENTS','SALES','STOCK'].map(async t=>{
   const file=path.join(csvDir,`${base}_${t}.csv`);
   return fs.readFile(file,'utf8').catch(e=>{throw Error(`Missing or unreadable ${file}: ${e.message}`)});
  }));
  const [adj, sales, stock]=files.map((f,i)=>parseRequired(f,[keysAdjustments,keysSales,keysStock][i],`${base}_${['ADJUSTMENTS','SALES','STOCK'][i]}`));
  for(const r of adj)monthMatches(r.Day,month,`${base} ADJUSTMENTS`);
  for(const r of sales)monthMatches(r.Day,month,`${base} SALES`);
  // Detect ShopifyQL paging gaps when the UI limit is reached exactly.
  if(adj.length===10000||sales.length===10000||stock.length===10000)throw Error(`${base}: 10000 rows exactly; verify OFFSET pagination and supply all pages`);
  const supplement=convertShopifyQlCsv({store,month,adjustmentsCsv:files[0],salesCsv:files[1]});
  const outArchive=path.join(root,'data','shopifyql-import',store,`${month}.json`);
  await fs.mkdir(path.dirname(outArchive),{recursive:true});
  await fs.writeFile(outArchive,JSON.stringify(supplement,null,2)+'\n');
  const aggregatedAdjustments=new Map();let unmatchedAdjustments=0;
  let potentialManualPositive=0,potentialCorrectionPositive=0;
  for(const r of adj){
   const id=getId(r);const amount=integer(r['Inventory adjustment change'],'adjustment change');
   const reason=String(r['Inventory change reason']||'').trim();const state=String(r['Inventory state']||'').trim();
   if(amount>0&&state==='available'&&reason==='manual_adjustment')potentialManualPositive+=amount;
   if(amount>0&&state==='available'&&reason==='correction')potentialCorrectionPositive+=amount;
   if(!id){unmatchedAdjustments++;continue;}
   const item=catalog.get(id)||historical.get(id)||{};
   const key=`${store}|${month}|${id}`;
   if(!aggregatedAdjustments.has(key))aggregatedAdjustments.set(key,{adjustmentId:key,source:'shopifyql_inventory_adjustment_history_csv',sourceLabel:'Shopify Inventory Adjustment CSV',store,storeLabel:store==='corro'?'Corro':'Cavali',month,quarter:month.slice(0,4)+'-Q'+(Math.floor((Number(month.slice(5,7))-1)/3)+1),inventoryItemId:item.inventoryItemId||'',variantId:gid(id),sku:item.sku||r['Product variant SKU']||'',product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',category:item.category||'Uncategorized',positiveAdjustments:0,negativeAdjustments:0,netAdjustments:0,rawPositiveAvailableAdjustments:0,correctionUnits:0,initialAdjustmentUnits:0,reasons:{},adjustmentLocations:[]});
   const row=aggregatedAdjustments.get(key);
   row.netAdjustments+=amount;
   // Display Stock + ONLY for manual available-stock increases, explicitly unverified.
   // A large Shopify correction/initial adjustment is NOT a physical supplier delivery.
   if(state==='available'){
     if(amount>0)row.rawPositiveAvailableAdjustments+=amount;
     if(reason==='correction')row.correctionUnits+=amount;
     if(reason==='initial_adjustment')row.initialAdjustmentUnits+=amount;
     if(reason==='manual_adjustment'){if(amount>0)row.positiveAdjustments+=amount;else row.negativeAdjustments+=amount;}
   }
   row.reasons[reason]=(row.reasons[reason]||0)+amount;
  }
  adjustmentRows.push(...aggregatedAdjustments.values());
  let unmappedStock=0,negativeStarts=0;
  const monthlyStock=new Map();
  for(const r of stock){
   const id=getId(r);if(!id){unmappedStock++;continue;}
   if(monthlyStock.has(id))throw Error(`${base}: duplicate inventory variant ID ${id}`);
   const startingUnits=integer(r['Starting inventory units'],'starting inventory');
   const unitsSold=integer(r['Inventory units sold'],'inventory units sold');
   const endingUnits=integer(r['Ending inventory units'],'ending inventory');
   const endingInventoryValue=money(r['Ending inventory value'],'ending inventory value');
   if(startingUnits<0)negativeStarts++;
   const item=catalog.get(id)||historical.get(id)||{};
   monthlyStock.set(id,{historyId:`${store}:${month}:${gid(id)}`,source:'shopifyql_inventory_csv',sourceLabel:'Shopify Inventory CSV (on hand after 2026-10-01)',store,storeLabel:store==='corro'?'Corro':'Cavali',month,quarter:month.slice(0,4)+'-Q'+(Math.floor((Number(month.slice(5,7))-1)/3)+1),inventoryItemId:item.inventoryItemId||'',variantId:gid(id),sku:item.sku||'',product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',category:item.category||'Uncategorized',brand:item.brand||'',startingUnits,unitsSold,endingUnits,netInventoryChange:endingUnits-startingUnits,endingInventoryValue:endingInventoryValue??0,unitCost:item.unitCost??null,currency:item.currency||'USD',sellThrough:unitsSold>0?unitsSold/(Math.max(0,unitsSold)+Math.max(0,endingUnits)):0,sellThroughSource:'inventory_units_sold_over_sold_plus_ending',isExactPurchaseHistory:false,positiveAdjustments:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.positiveAdjustments??0,negativeAdjustments:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.negativeAdjustments??0,netAdjustments:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.netAdjustments??0,rawPositiveAvailableAdjustments:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.rawPositiveAvailableAdjustments??0,correctionUnits:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.correctionUnits??0,initialAdjustmentUnits:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.initialAdjustmentUnits??0,adjustmentReasons:aggregatedAdjustments.get(`${store}|${month}|${id}`)?.reasons||{},adjustmentLocations:[]});
  }
  stockRows.push(...monthlyStock.values());latestStock=monthlyStock;
  let unknownSalesRows=0,unknownNetSold=0,unknownOrdered=0,missingCatalogSold=0,netSold=0,ordered=0;
  for(const [i,r] of sales.entries()){
   const day=r.Day;const id=getId(r);const item=(id && (catalog.get(id)||historical.get(id)))||{};
   const units=integer(r['Quantity ordered'],'quantity ordered');const netUnits=integer(r['Net items sold'],'net items sold');
   const netSales=money(r['Net sales'],'net sales');const cogs=money(r['Cost of goods sold'],'cost of goods sold');
   const sku=String(r['Product variant SKU']||'').trim();
   if(!id){unknownSalesRows++;unknownNetSold+=netUnits;unknownOrdered+=units;}
   else if(!item.variantId)missingCatalogSold+=units;
   ordered+=units;netSold+=netUnits;
   saleRows.push({...item,store,storeLabel:store==='corro'?'Corro':'Cavali',variantId:gid(id),inventoryItemId:item.inventoryItemId||'',sku:item.sku||sku,product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',category:item.category||'Uncategorized',brand:item.brand||'',currency:item.currency||'USD',tracked:id?item.tracked!==false:false,requiresShipping:id?item.requiresShipping!==false:false,eligibleForInventory:id?item.eligibleForInventory!==false:false,historicalPhysicalItem:id?item.historicalPhysicalItem!==false:false,source:'shopifyql_sales_csv',sourceLabel:'Shopify Analytics sales CSV',saleId:`shopifyql:manual:${store}:${month}:${i}:${day}:${id||'unidentified'}`,soldAt:day,units,quantityOrdered:units,netUnits,netSales,costOfGoodsSold:cogs,costSource:cogs===null?'unavailable':'shopifyql_cost_of_goods_sold',salesMetric:'quantity_ordered',netSalesSource:netSales===null?'unavailable':'shopifyql_net_sales'});
  }
  // Actual CSV day coverage might end before the query's requested end date.
  const maxSaleDay=sales.reduce((m,r)=>r.Day>m?r.Day:m,'');
  coverageSales[month]={status:'success',source:'manual_shopifyql_csv',start:month+'-01',end:month===through.slice(0,7)?through:month+'-'+new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate(),rows:sales.length,quantityOrdered:ordered,netUnits:netSold,unidentifiedProductRows:unknownSalesRows,unidentifiedQuantityOrdered:unknownOrdered,unidentifiedNetUnits:unknownNetSold};
  coverageAdj[month]={status:'success',source:'manual_shopifyql_csv',events:adj.length,verifiedReceipts:supplement.summary.verifiedReceiptUnits,unidentifiedReceiptUnits:supplement.summary.unidentifiedReceiptUnits};
  stats.push({store,month,adjustmentRows:adj.length,stockRows:stock.length,salesRows:sales.length,quantityOrdered:ordered,netItemsSold:netSold,verifiedPOUnits:supplement.summary.verifiedReceiptUnits,unidentifiedPOUnits:supplement.summary.unidentifiedReceiptUnits,manualPositiveAvailableUnits:potentialManualPositive,correctionPositiveAvailableUnits:potentialCorrectionPositive,unidentifiedSalesRows:unknownSalesRows,negativeStartingVariants:negativeStarts,missingCatalogSalesUnits:missingCatalogSold,missingStockVariantRows:unmappedStock,maxSaleDay});
  for(const r of supplement.receipts){
   const id=q(r.variantId),item=catalog.get(id)||historical.get(id);
   if(!item?.inventoryItemId){continue;}
   addedReceipts.push({receiptId:`shopifyql:csv:${store}:${r.day}:${r.variantId}:${r.sourceDocument}`,store,storeLabel:store==='corro'?'Corro':'Cavali',source:'shopifyql_verified_po_event',sourceLabel:'ShopifyQL purchase order received',cohortType:'receipt',dateBasis:'received',evidenceLevel:'purchase_reference',isEstimated:false,historicalPhysicalItem:true,cohortDate:r.day,cohortMonth:month,receivedAt:r.day,inventoryItemId:item.inventoryItemId,variantId:r.variantId,sku:item.sku||r.sku,product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',category:item.category||'Uncategorized',unitsReceived:r.unitsReceived,unitCost:item.unitCost??null,costBasis:'current_item_cost_not_historical',retailPrice:item.retailPrice??null,currency:item.currency||'USD',sourceReason:r.sourceReason,sourceDocument:r.sourceDocument,stockStateEvidence:'available'});
  }
 }
 const keep=r=>r.store!==store||!dates.has(String(r.month||r.soldAt||r.cohortMonth||'').slice(0,7));
 source.monthlyInventory=[...(source.monthlyInventory||[]).filter(keep),...stockRows];
 source.monthlyAdjustments=[...(source.monthlyAdjustments||[]).filter(keep),...adjustmentRows];
 source.sales=[...(source.sales||[]).filter(keep),...saleRows];
 // Avoid duplicate PO entries if rerun with the same dates.
 source.cohortInputs=[...(source.cohortInputs||[]).filter(keep),...addedReceipts];
 source.cohorts=(source.cohorts||[]).filter(keep);
 const nextStock=latestStock;
 source.currentInventory=(source.currentInventory||[]).map(item=>{
   if(item.store!==store)return item;
   const snapshot=nextStock.get(q(item.variantId));if(!snapshot)return item;
   return {...item,currentUnits:snapshot.endingUnits,inventoryValue:snapshot.endingInventoryValue,inventorySource:'shopifyql_inventory_csv',inventoryMeasurement:'on_hand'};
 });
 const prior=source.meta.stores[store]||{};
 const newThrough=through>String(prior.salesThrough||'')?through:prior.salesThrough;
 source.meta={...source.meta,generatedAt:new Date().toISOString(),source:'ShopifyQL CSV manual consolidation of historical Shopify data; original API store(s) retained',manualCsvStores:[...new Set([...(source.meta.manualCsvStores||[]),store])],manualCsvMonths:{...(source.meta.manualCsvMonths||{}),[store]:months},manualSyncThrough:through,manualImportWarning:'Supplier receipts require purchase_order_received with a matching purchase order. Manual/correction/initial adjustments were NOT classified as supplier purchases.',stores:{...source.meta.stores,[store]:{...prior,salesThrough:newThrough,salesMetric:'quantity_ordered',salesSource:'shopifyql_sales_csv',salesDailyCoverage:coverageSales,nativeDailyCoverage:coverageAdj,manualCsvImportedMonths:months,manualCsvImportThrough:through,manualCsvReceiptUnits:stats.reduce((s,x)=>s+x.verifiedPOUnits,0),manualUnverifiedAdjustmentUnits:stats.reduce((s,x)=>s+x.manualPositiveAvailableUnits,0)}}};
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(source));
 const reportFile=path.resolve(root,'data','shopifyql-import',store,'CSV-IMPORT-AUDIT.json');
 await fs.writeFile(reportFile,JSON.stringify({generatedAt:source.meta.generatedAt,store,through,results:stats,note:'Corrections and manual stock adjustments are NOT counted as vendor receipts. 30/60/90 FIFO attribution is only an estimate when baseline stock is documented.'},null,2)+'\n');
 return {output,reportFile,results:stats};
}
if(process.argv[1] && path.resolve(process.argv[1])===new URL(import.meta.url).pathname){
 const params=Object.fromEntries(process.argv.slice(2).reduce((xs,x,i,arr)=>{if(i%2===0)xs.push([x.replace(/^--/,''),arr[i+1]]);return xs;},[]));
 const output=params.output||path.join(process.cwd(),'manual-shopify-source.json');
 importManualShopifyHistory({root:process.cwd(),store:params.store,months:String(params.months||'').split(','),csvDir:params['csv-dir'],output,through:params.through}).then(res=>console.log(JSON.stringify(res,null,2))).catch(err=>{console.error('Manual CSV import failed: '+err.message);process.exitCode=1});
}
