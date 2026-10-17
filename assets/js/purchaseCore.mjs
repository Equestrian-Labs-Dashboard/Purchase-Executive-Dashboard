import {checkpoint, isReceivedCohort} from './rotationCore.mjs';
export const valid = v => v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v));
const sum = (rows, field) => rows.reduce((n,r)=>n+(Number(r[field])||0),0);
export const addDays = (day,n) => new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function periodRange(type, period, asOf) {
  const year=Number(period.slice(0,4));
  if(type==='ytd') return {start:`${year}-01-01`,end:asOf.slice(0,4)===String(year)?asOf:`${year}-12-31`};
  const month=type==='quarter'?(Number(period.slice(-1))-1)*3+1:Number(period.slice(5,7));
  return {start:`${year}-${String(month).padStart(2,'0')}-01`,end:new Date(Date.UTC(year,month+(type==='quarter'?2:0),0)).toISOString().slice(0,10)};
}
export const matches = (row, filters) => ['store','vendor','brand'].every(k=>!filters[k]||filters[k]==='all'||(row[k]||'Unspecified')===filters[k]);
export function completeCoverage(info, start, end, field) {
  if(!start || !end || start>end) return false;
  for(let d=start;d<=end;d=addDays(d,1)) {
    const c=info?.salesDailyCoverage?.[d.slice(0,7)];
    if(!['success','cached'].includes(c?.status)||!c.start||!c.end||c.start>d||c.end<d) return false;
    if(field==='costOfGoodsSold' && c.costMetric!=='cost_of_goods_sold') return false;
    if(field && field!=='costOfGoodsSold' && !(c.financialMetrics||[]).includes(field)) return false;
  }
  return true;
}
export function receiptGroups(data, filters) {
  const range=periodRange(filters.type,filters.period,data.asOf), map=new Map();
  for(const r of data.receipts.filter(isReceivedCohort).filter(r=>valid(r.unitsReceived)&&r.unitsReceived>0&&matches(r,filters))) {
    const date=r.receivedAt||r.cohortDate;
    if(date<range.start||date>range.end||date>data.asOf)continue;
    const key=JSON.stringify([r.store,r.vendor,date,r.currency||'Unknown']);
    if(!map.has(key))map.set(key,{key,store:r.store,vendor:r.vendor,date,currency:r.currency||'Unknown',rows:[]});
    map.get(key).rows.push(r);
  }
  return [...map.values()].map(g=>{
    const units=sum(g.rows,'unitsReceived');
    const costsComplete=g.rows.every(r=>valid(r.unitCost)&&Number(r.unitCost)>0&&['purchase_order_cost','manual_recorded_cost'].includes(r.costBasis));
    const cost=costsComplete?g.rows.reduce((n,r)=>n+r.unitsReceived*r.unitCost,0):null;
    const retail=g.rows.every(r=>valid(r.retailPrice)&&r.retailPrice>0&&r.retailCurrency===g.currency&&g.currency!=='Unknown')?g.rows.reduce((n,r)=>n+r.unitsReceived*r.retailPrice,0):null;
    const through=data.meta.stores[g.store]?.salesThrough||data.asOf, windows={};
    for(const days of [30,60,90]) {
      const end=addDays(g.date,days-1), coveredEnd=end<through?end:through;
      // Allocation uses the entire stock timeline, not just this receipt window.
      const covered=completeCoverage(data.meta.stores[g.store],data.meta.startDate,coveredEnd);
      const points=g.rows.map(r=>covered?checkpoint(r,days,through):{status:'unavailable'});
      const status=points.some(p=>p.status==='unavailable')?'unavailable':points.some(p=>p.status==='pending')?'pending':'ready';
      const sold=status==='unavailable'?null:points.reduce((n,p)=>n+(p.units??p.soFarUnits??0),0);
      windows[days]={status,start:g.date,end,units:sold,pct:sold!==null&&units>0?sold/units*100:null};
    }
    const remaining90=windows[90].status==='ready'?units-windows[90].units:null;
    return {...g,units,cost,retail,markup:cost>0&&retail!==null?(retail/cost-1)*100:null,windows,remaining90};
  }).sort((a,b)=>b.date.localeCompare(a.date)||a.vendor.localeCompare(b.vendor));
}
export function selectedPerformance(data,filters) {
  const range=periodRange(filters.type,filters.period,data.asOf);
  const stores=Object.keys(data.meta.stores).filter(s=>filters.store==='all'||filters.store===s);
  const sales=data.sales.filter(r=>matches(r,filters)&&r.soldAt>=range.start&&r.soldAt<=range.end);
  const covered=stores.length>0&&stores.every(s=>completeCoverage(data.meta.stores[s],range.start,[range.end,data.meta.stores[s].salesThrough||data.asOf].sort()[0]));
  const currencies=[...new Set(sales.map(r=>r.currency).filter(Boolean))];
  const moneyCovered=currencies.length===1&&sales.every(r=>r.currency===currencies[0]);
  const metric=field=>covered&&moneyCovered&&stores.every(s=>completeCoverage(data.meta.stores[s],range.start,[range.end,data.meta.stores[s].salesThrough||data.asOf].sort()[0],field))&&sales.every(r=>valid(r[field]))?sum(sales,field):null;
  const cost=metric('costOfGoodsSold'),netSales=metric('netSales'),discounts=metric('discounts');
  const catalog=data.catalog.filter(r=>matches(r,filters)&&r.currentUnits>0&&r.unitCost>0&&r.retailPrice>0);
  const catalogCurrency=[...new Set(catalog.map(r=>r.currency))];
  const catalogCost=catalog.reduce((n,r)=>n+r.currentUnits*r.unitCost,0),catalogRetail=catalog.reduce((n,r)=>n+r.currentUnits*r.retailPrice,0);
  return {range,covered,ordered:covered?sum(sales,'quantityOrdered'):null,net:covered?sum(sales,'netUnits'):null,cost,netSales,discounts,
    currency:currencies.length===1?currencies[0]:null,grossProfit:cost!==null&&netSales!==null?netSales-cost:null,
    catalogMarkup:catalogCurrency.length===1&&catalogCost>0?(catalogRetail/catalogCost-1)*100:null};
}
export function receiptTotals(groups) {
  const complete90=groups.filter(g=>g.windows[90].status==='ready');
  const units90=sum(complete90,'units'),sold90=complete90.reduce((n,g)=>n+g.windows[90].units,0);
  const currency=[...new Set(groups.map(g=>g.currency))];
  const cost=groups.length&&currency.length===1&&currency[0]!=='Unknown'&&groups.every(g=>g.cost!==null)?sum(groups,'cost'):null;
  return {units:groups.length?sum(groups,'units'):null,cost,currency:currency.length===1?currency[0]:null,
    markup:cost>0&&groups.every(g=>g.retail!==null)?(sum(groups,'retail')/cost-1)*100:null,
    sold90:units90?sold90:null,rate90:units90?sold90/units90*100:null,remaining90:units90?units90-sold90:null,mature:complete90.length};
}
// Seeded, reproducible sample; export records explicitly distinguish local source checks from Shopify review.
export function sampleVendors(data,filters,count=5) {
  const range=periodRange(filters.type,filters.period,data.asOf);
  const activity=[...data.sales.filter(r=>(r.quantityOrdered||r.netUnits)&&r.soldAt>=range.start&&r.soldAt<=range.end),...data.receipts.filter(r=>(r.receivedAt||r.cohortDate)>=range.start&&(r.receivedAt||r.cohortDate)<=range.end)];
  const candidates=[...new Set(activity.filter(r=>r.vendor&&r.vendor!=='Unknown'&&matches(r,{...filters,vendor:'all'})).map(r=>JSON.stringify([r.store,r.vendor])))];
  const hash=s=>[...s].reduce((n,c)=>Math.imul(n^c.charCodeAt(0),16777619)>>>0,2166136261);
  return candidates.sort((a,b)=>hash(data.meta.generatedAt+a)-hash(data.meta.generatedAt+b)).slice(0,count).map(key=>{
    const [store,vendor]=JSON.parse(key),f={...filters,store,vendor},groups=receiptGroups(data,f),perf=selectedPerformance(data,f),totals=receiptTotals(groups);
    return {store,vendor,period:filters.period,unitsIn:totals.units,dateReceived:groups.map(g=>g.date),receiptCOGS:totals.cost,markup:totals.markup,
      windows:groups.map(g=>({date:g.date,windows:g.windows})),quantityOrdered:perf.ordered,netItemsSold:perf.net,
      sourceCheck:groups.length?'Local export only; Shopify document review required':'Receipt fields absent in export',shopifyComparison:'Not independently checked',difference:null};
  });
}
