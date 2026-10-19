/** Offline ShopifyQL CSV import. Never invents supplier purchases or dated FIFO sales.
 * Records positive available-stock purchase_order_received events linked to a
 * Shopify PurchaseOrder document, and archives net-items-sold for reconciliation.
 * Actual 30/60/90 cohort sales require a complete order/stock opening timeline.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const REQUIRED_ADJUSTMENTS = ['Day','Product variant ID','Product variant SKU','Inventory change reason','Inventory state','Reference document URI','Inventory adjustment change'];
export const REQUIRED_SALES = ['Day','Product variant ID','Product variant SKU','Net items sold'];
export function parseCsv(content){
  const input=String(content).replace(/^\uFEFF/,'');
  const lines=[];let fields=[],cell='',quoted=false;
  for(let i=0;i<input.length;i++){
    const c=input[i];
    if(quoted){if(c==='"' && input[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}
    else if(c==='"'){if(cell)throw Error('Invalid quote in CSV');quoted=true;}
    else if(c===','){fields.push(cell);cell='';}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&input[i+1]==='\n')i++;fields.push(cell);if(fields.some(s=>s!==''))lines.push(fields);fields=[];cell='';}
    else cell+=c;
  }
  if(quoted)throw Error('Unclosed quoted CSV field');
  fields.push(cell);if(fields.some(s=>s!==''))lines.push(fields);
  if(!lines.length)throw Error('Empty CSV');
  const header=lines.shift().map(x=>x.trim());if(new Set(header).size!==header.length)throw Error('Duplicate CSV column');
  return {header,rows:lines.map((items,i)=>{
    if(items.length!==header.length)throw Error(`CSV row ${i+2} has ${items.length} fields, expected ${header.length}`);
    return Object.fromEntries(header.map((name,j)=>[name,items[j]]));
  })};
}
const validDate = date=>/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
function assertHeaders(actual,required){for(const name of required)if(!actual.includes(name))throw Error(`Missing ShopifyQL CSV column: ${name}`);}
function assertInteger(value,label){if(!/^-?\d+$/.test(String(value).trim()))throw Error(`Invalid ${label}: ${value}`);const n=Number(value);if(!Number.isSafeInteger(n))throw Error(`Unsafe ${label}`);return n;}
function validVariant(value){const str=String(value).trim();if(!/^\d+$/.test(str) && !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(str))throw Error('Invalid Product variant ID');return str.split('/').at(-1);}
export function convertShopifyQlCsv({adjustmentsCsv,salesCsv,store,month}){
  if(!['corro','cavali'].includes(store))throw Error('Store must be corro or cavali');
  if(!/^20\d\d-(0[1-9]|1[0-2])$/.test(month))throw Error('Month must be YYYY-MM');
  const adjustment=parseCsv(adjustmentsCsv),sales=parseCsv(salesCsv);
  assertHeaders(adjustment.header,REQUIRED_ADJUSTMENTS);assertHeaders(sales.header,REQUIRED_SALES);
  const purchaseRows=new Map();let filtered=0,returns=0,otherAdjustments=0,unidentifiedReceiptRows=0,unidentifiedReceiptUnits=0,unidentifiedSalesRows=0,unidentifiedNetSales=0;
  for(const r of adjustment.rows){
    const day=String(r.Day).trim();if(!validDate(day)||day.slice(0,7)!==month)throw Error(`Adjustment CSV contains date outside ${month}: ${day}`);
    const rawId=String(r['Product variant ID']).trim();const id=rawId?validVariant(rawId):'';const qty=assertInteger(r['Inventory adjustment change'],'inventory adjustment');
    const reason=String(r['Inventory change reason']).toLowerCase().trim();const state=String(r['Inventory state']).toLowerCase().trim();const document=String(r['Reference document URI']).trim();
    if(reason==='restock'||reason.includes('return'))returns++;
    if(reason==='purchase_order_received'&&state==='available'&&qty>0&&/^gid:\/\/shopify\/(?:Inventory)?PurchaseOrder\/\d+$/.test(document)&&!id){unidentifiedReceiptRows++;unidentifiedReceiptUnits+=qty;}
    if(id&&reason==='purchase_order_received'&&state==='available'&&qty>0&&/^gid:\/\/shopify\/(?:Inventory)?PurchaseOrder\/\d+$/.test(document)){
      const key=JSON.stringify([day,id,document]);
      const existing=purchaseRows.get(key);
      if(existing && existing.sku!==String(r['Product variant SKU']).trim())throw Error(`Conflicting SKUs for ${id} ${day}`);
      if(existing) existing.unitsReceived+=qty;
      else purchaseRows.set(key,{day,variantId:`gid://shopify/ProductVariant/${id}`,sku:String(r['Product variant SKU']).trim(),sourceDocument:document,unitsReceived:qty,sourceReason:'purchase_order_received',inventoryState:'available',evidence:'shopifyql_po_receipt'});
    } else {filtered++;if(qty>0&&state==='available')otherAdjustments+=qty;}
  }
  const salesMap=new Map();
  for(const r of sales.rows){const day=String(r.Day).trim();if(!validDate(day)||day.slice(0,7)!==month)throw Error(`Sales CSV contains date outside ${month}: ${day}`);
    const rawId=String(r['Product variant ID']).trim();const qty=assertInteger(r['Net items sold'],'net items sold');if(!rawId){unidentifiedSalesRows++;unidentifiedNetSales+=qty;continue;}const id=validVariant(rawId);const sku=String(r['Product variant SKU']).trim();const key=JSON.stringify([day,id]);
    const old=salesMap.get(key);if(old && old.sku!==sku && old.sku && sku)throw Error(`Conflicting sales SKU ${id} ${day}`);
    if(old)old.netItemsSold+=qty;else salesMap.set(key,{day,variantId:`gid://shopify/ProductVariant/${id}`,sku,netItemsSold:qty});
  }
  const receipts=[...purchaseRows.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.variantId.localeCompare(b.variantId));
  const salesByDay=[...salesMap.values()].sort((a,b)=>a.day.localeCompare(b.day)||a.variantId.localeCompare(b.variantId));
  return {schema:'shopifyql-receipt-evidence-v1',store,month,source:'ShopifyQL CSV: inventory_adjustment_history and sales (net_items_sold)',
    warning:'Net items sold are NOT FIFO lot sales; opening inventory is not included. Costs and supplier name are not present in these exports.',
    receipts,salesByDay,summary:{adjustmentRows:adjustment.rows.length,salesRows:sales.rows.length,verifiedReceiptRows:receipts.length,verifiedReceiptUnits:receipts.reduce((n,r)=>n+r.unitsReceived,0),filteredAdjustmentRows:filtered,unidentifiedReceiptRows,unidentifiedReceiptUnits,unidentifiedSalesRows,unidentifiedNetSales,otherPositiveAvailableUnits:otherAdjustments,netItemsSold:salesByDay.reduce((n,r)=>n+r.netItemsSold,0),customerRestockAdjustmentRows:returns}};
}
export async function loadSupplementalReceipts({root=process.cwd(),store,catalog,startDate}){
  const directory=path.join(root,'data','shopifyql-import',store);let names=[];
  try{names=(await fs.readdir(directory)).filter(n=>/^20\d\d-(0[1-9]|1[0-2])\.json$/.test(n));}
  catch(error){if(error.code==='ENOENT')return {events:[],months:[],unattributedUnits:0,unmatchedCatalogUnits:0,matchedReceiptUnits:0};throw error;}
  const byId=new Map(catalog.filter(c=>c.variantId).map(c=>[c.variantId,c]));
  const events=[];const months=[];let unattributedUnits=0,unmatchedCatalogUnits=0,matchedReceiptUnits=0;
  for(const name of names.sort()){
    const archive=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
    if(archive.schema!=='shopifyql-receipt-evidence-v1'||archive.store!==store||archive.month!==name.slice(0,7))throw Error(`Invalid receipt evidence archive: ${name}`);
    months.push(archive.month);
    unattributedUnits+=Number(archive.summary?.unidentifiedReceiptUnits||0);
    for(const r of archive.receipts){
      if(!validDate(r.day)||r.day.slice(0,7)!==archive.month||r.day<startDate)continue;
      if(r.sourceReason!=='purchase_order_received'||r.inventoryState!=='available'||!/^gid:\/\/shopify\/(?:Inventory)?PurchaseOrder\/\d+$/.test(r.sourceDocument)||!Number.isSafeInteger(r.unitsReceived)||r.unitsReceived<=0)throw Error(`Invalid proof in ${name}`);
      const item=byId.get(r.variantId);
      if(!item||item.eligibleForInventory===false||item.tracked===false||item.requiresShipping===false){unmatchedCatalogUnits+=r.unitsReceived;continue;}
      matchedReceiptUnits+=r.unitsReceived;
      events.push({receiptId:`shopifyql:csv:${store}:${r.day}:${r.variantId}:${r.sourceDocument}`,
        store,storeLabel:store==='corro'?'Corro':'Cavali',source:'shopifyql_verified_po_event',sourceLabel:'ShopifyQL purchase order received · available stock',
        cohortType:'receipt',dateBasis:'received',evidenceLevel:'purchase_reference',isEstimated:false,historicalPhysicalItem:true,
        cohortDate:r.day,cohortMonth:r.day.slice(0,7),receivedAt:r.day,inventoryItemId:item.inventoryItemId,variantId:r.variantId,
        sku:item.sku||r.sku,product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',category:item.category||'Uncategorized',
        unitsReceived:r.unitsReceived,unitCost:item.unitCost??null,costBasis:'current_item_cost',retailPrice:item.retailPrice??null,
        currency:item.currency||'',sourceReason:r.sourceReason,sourceDocument:r.sourceDocument,stockStateEvidence:'available'});
    }
  }
  return {events,months,unattributedUnits,unmatchedCatalogUnits,matchedReceiptUnits};
}

export async function mainCli(argv=process.argv.slice(2)){
  const opts={};for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith('--')||argv[i+1]===undefined)throw Error('Use --store corro --month 2026-01 --adjustments FILE.csv --sales FILE.csv');opts[argv[i].slice(2)]=argv[i+1];}
  for(const key of ['store','month','adjustments','sales'])if(!opts[key])throw Error(`Missing --${key}`);
  const result=convertShopifyQlCsv({store:opts.store,month:opts.month,adjustmentsCsv:await fs.readFile(opts.adjustments,'utf8'),salesCsv:await fs.readFile(opts.sales,'utf8')});
  const output=path.join(process.cwd(),'data/shopifyql-import',result.store,`${result.month}.json`);
  await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({file:output,store:result.store,month:result.month,...result.summary},null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===new URL(import.meta.url).pathname){mainCli().catch(err=>{console.error(err.message);process.exitCode=1;});}
