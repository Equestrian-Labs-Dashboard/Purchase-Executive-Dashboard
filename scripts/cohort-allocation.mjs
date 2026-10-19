/** SKU-level FIFO ESTIMATE for supplier receipts and Shopify restocks.
 * Exact received quantities/dates are drawn from Shopify documents/events.
 * Without physical lot tracking, allocating sales to a particular lot cannot
 * be proven; do not describe any ratio as physical-batch exact.
 * Opening stock is sourced from the actual start-of-period Shopify inventory
 * snapshot, NOT back-solved from present-day stock and recent orders.
 */
const qty = v => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
const text = v => String(v??'').trim().toLowerCase();
export const inventoryIdentity = x=>x?.inventoryItemId ? `iid:${x.inventoryItemId}` : x?.variantId?`vid:${x.variantId}`:x?.sku?`sku:${text(x.sku)}`:`product:${text(x?.product)}|${text(x?.variant)}`;
const utcDays = (start,end) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`))/86400000);
const monthOf = d=>String(d||'').slice(0,7);
const emptyOffsets=()=>({M0:0,M1:0,M2:0,M3:0,M4:0,M5:0,M6Plus:0});
function offsetBucket(dateStart,dateEnd){const [a,b]=[dateStart,dateEnd].map(d=>d.slice(0,7).split('-').map(Number));const m=(b[0]-a[0])*12+b[1]-a[1];return m<=0?'M0':m<6?`M${m}`:'M6Plus';}
function join(rows){const m=new Map();for(const x of rows){const k=inventoryIdentity(x);if(!m.has(k))m.set(k,[]);m.get(k).push(x);}return m;}
export function allocateDatedCohorts({shop,receipts,sales,catalog,openingHistory,startDate,inventoryReturns=[]}) {
 const eligible = x=>x?.tracked!==false && x?.requiresShipping!==false && (x?.historicalPhysicalItem===true || x?.eligibleForInventory!==false);
 const products=catalog.filter(eligible);
 const productsBy= new Map(products.map(x=>[inventoryIdentity(x),x]));
 const stocked = join(receipts.filter(eligible));
 const returned = join(inventoryReturns.filter(eligible));
 const sold = join(sales.filter(eligible).filter(x=>String(x.soldAt||'')>=startDate));
 const month=monthOf(startDate);
 const baseline=new Map((openingHistory||[]).filter(x=>x.store===shop.key && x.month===month).map(x=>[inventoryIdentity(x),x]));
 const keys=new Set([...productsBy.keys(),...stocked.keys(),...sold.keys(),...returned.keys()]);
 const cohorts=[],inventory=[],receiptMonthLedger=[];
 let unallocatedUnits=0,unallocatedItems=0,openingEstimateUnits=0,missingOpeningSkus=0;
 for(const key of keys){
   const lines=[...(stocked.get(key)||[])].sort((a,b)=>a.cohortDate.localeCompare(b.cohortDate)||String(a.receiptId).localeCompare(String(b.receiptId)));
   const orders=[...(sold.get(key)||[])].sort((a,b)=>a.soldAt.localeCompare(b.soldAt)||String(a.saleId).localeCompare(String(b.saleId)));
   const returns=returned.get(key)||[];
   const item=productsBy.get(key)||lines[0]||orders[0]||returns[0]||{};
   const hasStart=baseline.has(key) && Number(baseline.get(key).startingUnits)>=0;
   if(!hasStart)missingOpeningSkus++;
   const opening=hasStart?qty(baseline.get(key).startingUnits):0;
   openingEstimateUnits+=opening;
   // Customer returns replenish available stock but are not supplier cohorts.
   const datedLots=[...lines.map(row=>({kind:'cohort',row,remaining:qty(row.unitsReceived),unitsSold:0,soldWithinDays:{30:0,60:0,90:0},soldByOffset:emptyOffsets()})),
     ...returns.map(row=>({kind:'return',row,remaining:qty(row.unitsRestocked ?? row.unitsReceived)}))]
     .sort((a,b)=>a.row.cohortDate.localeCompare(b.row.cohortDate)||String(a.row.receiptId).localeCompare(String(b.row.receiptId)));
   const lots=[{kind:'opening',remaining:opening},...datedLots];
   // Per-SKU/per-calendar-month stock ledger. Count a unit sold exactly once:
   // (a) newly received supplier stock, (b) prior opening/older receipts,
   // (c) non-purchase returns/observed adjustments or (d) unmatched.
   const byMonth=new Map();
   const monthLine=month=>{
     if(!byMonth.has(month))byMonth.set(month,{
       store:shop.key,storeLabel:shop.label,month,inventoryItemId:item.inventoryItemId||'',variantId:item.variantId||'',
       sku:item.sku||'',product:item.product||'',variant:item.variant||'',vendor:item.vendor||'Unknown',
       category:item.category||'Uncategorized',brand:item.brand||'',currency:item.currency||'',
       unitsReceived:0,soldFromMonthReceipts:0,previousStockSold:0,
       openingStockSold:0,olderReceiptSold:0,customerReturnStockSold:0,
       observedAdjustmentStockSold:0,unattributedSales:0,orderedUnits:0,netItemsSold:0,
       openingHistoryAvailable:hasStart,allocationConfidence:hasStart?'estimated_fifo':'missing_opening_stock'
     });
     return byMonth.get(month);
   };
   for(const receipt of lines){
     if(receipt.cohortType==='receipt')monthLine(monthOf(receipt.cohortDate)).unitsReceived+=qty(receipt.unitsReceived);
   }
   let unmatched=0;
   for(const sale of orders){
     const salesMonth=monthLine(monthOf(sale.soldAt));
     salesMonth.orderedUnits+=qty(sale.units);
     if(Number.isFinite(Number(sale.netUnits)))salesMonth.netItemsSold+=Number(sale.netUnits);
     let remaining=qty(sale.units);
     for(const lot of lots){
       if(remaining===0)break;
       if(lot.remaining<=0 || lot.kind!=='opening' && sale.soldAt < lot.row.cohortDate) continue;
       const used=Math.min(remaining,lot.remaining);
       remaining-=used;lot.remaining-=used;
       if(lot.kind==='opening'){
         salesMonth.openingStockSold+=used;
         salesMonth.previousStockSold+=used;
       }else if(lot.kind==='return')salesMonth.customerReturnStockSold+=used;
       if(lot.kind==='cohort'){
         if(lot.row.cohortType==='receipt'){
           if(monthOf(lot.row.cohortDate)===monthOf(sale.soldAt))salesMonth.soldFromMonthReceipts+=used;
           else {salesMonth.olderReceiptSold+=used;salesMonth.previousStockSold+=used;}
         }else salesMonth.observedAdjustmentStockSold+=used;
         lot.unitsSold+=used;
         const age=utcDays(lot.row.cohortDate,sale.soldAt);
         // First 30 calendar days includes the receipt date and day 29;
         // day 30 starts the next window. The same rule applies to 60/90.
         for(const d of [30,60,90])if(age>=0 && age<d)lot.soldWithinDays[d]+=used;
         lot.soldByOffset[offsetBucket(lot.row.cohortDate,sale.soldAt)]+=used;
       }
     }
     unmatched+=remaining;salesMonth.unattributedSales+=remaining;
   }
   for(const record of byMonth.values())receiptMonthLedger.push(record);
   if(unmatched){unallocatedItems++;unallocatedUnits+=unmatched;}
   for(const lot of lots){
     if(lot.kind!=='cohort')continue;
     const row=lot.row;
     const skuOrderedWithinDays={},skuNetWithinDays={};
     for(const days of [30,60,90]){
       const window=orders.filter(s=>{const age=utcDays(row.cohortDate,s.soldAt);return age>=0&&age<days;});
       skuOrderedWithinDays[days]=window.reduce((sum,s)=>sum+qty(s.units),0);
       skuNetWithinDays[days]=window.every(s=>Number.isFinite(s.netUnits))?window.reduce((sum,s)=>sum+s.netUnits,0):null;
     }
     cohorts.push({...row,cohortMonth:row.cohortMonth||monthOf(row.cohortDate),unitsSold:lot.unitsSold,unitsRemaining:lot.remaining,inventoryCost:qty(row.unitsReceived)*qty(row.unitCost),soldByOffset:lot.soldByOffset,soldWithinDays:hasStart?lot.soldWithinDays:{},skuOrderedWithinDays,skuNetWithinDays,
       allocationMethod:'FIFO_FROM_STARTING_SHOPIFY_STOCK',openingHistoryAvailable:hasStart,
       // Missing baseline means a new SKU might already have existed before
       // reporting starts; report as unverified rather than claiming zero sales.
       allocationConfidence:hasStart?'estimated_fifo':'missing_opening_stock'});
   }
   inventory.push({...item,store:shop.key,storeLabel:shop.label,currentUnits:qty(item.currentUnits),unitCost:qty(item.unitCost),inventoryValue:qty(item.currentUnits)*qty(item.unitCost),unitsSoldSinceStart:orders.reduce((s,x)=>s+qty(x.units),0),openingEstimateInternal:opening,cohortRemaining:lots.filter(l=>l.kind==='cohort').reduce((s,l)=>s+l.remaining,0)});
 }
 return {cohorts,inventory,receiptMonthLedger,unallocatedUnits,unallocatedItems,openingEstimateUnits,missingOpeningSkus};
}
