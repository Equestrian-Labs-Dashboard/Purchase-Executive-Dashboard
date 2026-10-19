import {addDays, completeCoverage, matches, periodRange} from './purchaseCore.mjs';

const hasNumber = v => v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v));
const monthLast = month => new Date(Date.UTC(+month.slice(0,4), +month.slice(5),0)).toISOString().slice(0,10);
const variantKey = r => {
  const id=String(r.variantId||'').trim();
  return /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)?id:'';
};

// A cached CSV bridges missing variant IDs in the older portable export.
// When Shopify refreshes its live report, favor live sales over the cache,
// never double-count an existing day/variant pair.
export function mergeSkuSales(liveRows=[],importedRows=[]) {
  const collect=(rows)=>{
    const result=new Map();
    for(const row of rows||[]){
      if(row.store!=='corro'||!/^20\d\d-\d\d-\d\d$/.test(row.soldAt||'')||!variantKey(row)||!hasNumber(row.netUnits))continue;
      const key=`${row.soldAt}|${variantKey(row)}`;
      if(!result.has(key))result.set(key,{...row,quantityOrdered:hasNumber(row.quantityOrdered)?Number(row.quantityOrdered):null,netUnits:0});
      const dest=result.get(key);dest.netUnits+=Number(row.netUnits);
    }
    // Recalculate ordered totals from all source rows; null means unknown.
    for(const value of result.values())value.quantityOrdered=0;
    const absent=new Set();
    for(const row of rows||[]){const key=`${row.soldAt}|${variantKey(row)}`;
      if(!result.has(key))continue;
      if(!hasNumber(row.quantityOrdered))absent.add(key);
      else result.get(key).quantityOrdered+=Number(row.quantityOrdered);
    }
    for(const key of absent)result.get(key).quantityOrdered=null;
    return result;
  };
  const imported=collect(importedRows),live=collect(liveRows);
  return [...new Map([...imported,...live]).values()].sort((a,b)=>a.soldAt.localeCompare(b.soldAt)||variantKey(a).localeCompare(variantKey(b)));
}

/**
 * Non-overlapping SKU order comparison by dated, POSITIVE manual stock change.
 * NOT evidence of supplier purchase and NOT physical/FIFO batch sell-through.
 * Every SKU/day sales figure is assigned to its most recent eligible change at
 * the time of the order: it can never multiply across several stock increases.
 * Negative net units (cancellations/returns/reversals) remain negative.
 * ShopifyQL groups by DATE, so same-day order vs. stock entry order is unknown.
 */
export function stockMovementSales({evidence=[],sales=[],meta={},asOf,filters}) {
  const range=periodRange(filters.type,filters.period,asOf);
  const info=meta?.stores?.corro||{};
  const through=[asOf,info.salesThrough||asOf].sort()[0];
  const catalogEntries=[];
  for(const row of evidence||[]) {
    if(row.store!=='corro'||row.notSupplierProof!==true||row.sourceReason!=='manual_adjustment')continue;
    const id=variantKey(row),date=row.cohortDate,units=Number(row.unitsReceived);
    if(!id || !/^20\d\d-\d\d-\d\d$/.test(date||'')||date>through || !Number.isSafeInteger(units)||units<=0)continue;
    catalogEntries.push({...row,id,date,units,groupMonth:date.slice(0,7)});
  }
  const byVariant=new Map();
  for(const row of catalogEntries){
    if(!byVariant.has(row.id))byVariant.set(row.id,[]);
    byVariant.get(row.id).push({...row,orders:[]});
  }
  for(const entries of byVariant.values())entries.sort((a,b)=>a.date.localeCompare(b.date)||String(a.vendor).localeCompare(String(b.vendor)));

  // Allocate each sales/day row ONCE to the newest eligible event for that SKU.
  // This is order-timing context, not proof which physical inventory was used.
  for(const row of sales||[]){
    if(row.store!=='corro'||!variantKey(row)||!/^20\d\d-\d\d-\d\d$/.test(row.soldAt||'')||row.soldAt>through||!hasNumber(row.netUnits))continue;
    const entries=byVariant.get(variantKey(row));if(!entries)continue;
    let match=null;
    for(const event of entries){if(event.date<=row.soldAt)match=event;else break;}
    if(match)match.orders.push({day:row.soldAt,units:Number(row.netUnits)});
  }
  const groups=new Map();
  for(const entries of byVariant.values())for(const entry of entries){
    if(entry.date<range.start||entry.date>range.end||!matches(entry,filters))continue;
    const key=JSON.stringify([entry.vendor||'Unknown',entry.groupMonth]);
    if(!groups.has(key))groups.set(key,{store:'corro',vendor:entry.vendor||'Unknown',month:entry.groupMonth,dates:new Set(),events:[]});
    groups.get(key).dates.add(entry.date);groups.get(key).events.push(entry);
  }
  const point=(events,days)=>{
    let value=0,known=true,finished=true,cutoff='';
    for(const entry of events){
      const end=days===0?monthLast(entry.groupMonth):addDays(entry.date,days-1);
      if(end>cutoff)cutoff=end;
      const stop=end<through?end:through;
      if(stop<entry.date||!completeCoverage(info,entry.date,stop)){known=false;continue;}
      value+=entry.orders.filter(o=>o.day<=stop).reduce((sum,o)=>sum+o.units,0);
      if(end>through)finished=false;
    }
    return {units:known?value:null,status:!known?'unavailable':finished?'complete':'pending',end:cutoff,ratio:null};
  };
  return [...groups.values()].map(group=>{
    const entries=group.events,units=entries.reduce((s,r)=>s+r.units,0),currencies=[...new Set(entries.map(r=>r.currency).filter(Boolean))];
    const currency=currencies.length===1&&entries.every(r=>r.currency===currencies[0])?currencies[0]:null;
    const knownCosts=entries.filter(r=>hasNumber(r.unitCost)&&Number(r.unitCost)>0&&r.currency===currency);
    const knownRetail=entries.filter(r=>hasNumber(r.retailPrice)&&Number(r.retailPrice)>0&&r.currency===currency);
    const costKnownUnits=knownCosts.reduce((s,r)=>s+r.units,0);
    const retailKnownUnits=knownRetail.reduce((s,r)=>s+r.units,0);
    const costSubtotal=currency?knownCosts.reduce((s,r)=>s+r.units*Number(r.unitCost),0):null;
    const retailSubtotal=currency?knownRetail.reduce((s,r)=>s+r.units*Number(r.retailPrice),0):null;
    const currentCost=currency&&costKnownUnits===units?costSubtotal:null;
    const retail=currency&&retailKnownUnits===units?retailSubtotal:null;
    const windows=Object.fromEntries([30,60,90].map(d=>[d,point(entries,d)]));
    const inMonth=point(entries,0);
    for(const w of [inMonth,...Object.values(windows)])w.ratio=w.units!==null&&units>0?100*w.units/units:null;
    const skuIds=[...new Set(entries.map(e=>e.id))];
    return {store:'corro',vendor:group.vendor,month:group.month,dates:[...group.dates].sort(),units,skuCount:skuIds.length,
      events:entries,datesRange:group.dates.size,unitCostBasis:'current_item_cost',currency,currentCost,retail,costSubtotal,retailSubtotal,costKnownUnits,retailKnownUnits,skuIds,
      catalogMarkup:currentCost!==null&&currentCost>0&&retail!==null?100*(retail/currentCost-1):null,
      inMonth,windows,verified:false,
      note:'Dated manual stock increase; SKU net orders after change, not a confirmed supplier purchase or batch sell-through.'};
  }).sort((a,b)=>b.month.localeCompare(a.month)||b.units-a.units||a.vendor.localeCompare(b.vendor));
}
