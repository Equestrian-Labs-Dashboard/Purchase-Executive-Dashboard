import {periodRange,matches} from './purchaseCore.mjs';
const validCost=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))&&Number(v)>0;
// A Shopify manual adjustment is evidence of a stock increase, NOT an
// authenticated supplier delivery or a historical invoice price.
export function observedStockGroups(rows, filters, asOf) {
  const range=periodRange(filters.type,filters.period,asOf);
  const map=new Map();
  for(const r of (rows||[])){
    if(r.store!=='corro'||r.notSupplierProof!==true||r.sourceReason!=='manual_adjustment')continue;
    if(!matches(r,filters))continue;
    const day=r.cohortDate;if(!/^20\d\d-\d\d-\d\d$/.test(day)||day<range.start||day>range.end||day>asOf)continue;
    const qty=Number(r.unitsReceived);if(!Number.isSafeInteger(qty)||qty<=0)continue;
    const month=day.slice(0,7),key=JSON.stringify([r.vendor||'Unknown',month]);
    if(!map.has(key))map.set(key,{store:'corro',vendor:r.vendor||'Unknown',month,units:0,dates:new Set(),skuIds:new Set(),pricedUnits:0,estimatedCurrentCost:0,currency:r.currency||'',costCurrencies:new Set()});
    const g=map.get(key);g.units+=qty;g.dates.add(day);g.skuIds.add(r.variantId||r.sku||'?');
    if(validCost(r.unitCost)&&r.currency){g.pricedUnits+=qty;g.estimatedCurrentCost+=qty*Number(r.unitCost);g.costCurrencies.add(r.currency);}
  }
  return [...map.values()].map(g=>({...g,dates:[...g.dates].sort(),skuCount:g.skuIds.size,skuIds:undefined,
    estimatedCurrentCost:g.pricedUnits===g.units&&g.costCurrencies.size===1?g.estimatedCurrentCost:null,
    costCurrency:g.costCurrencies.size===1?[...g.costCurrencies][0]:null,costCurrencies:undefined}))
    .sort((a,b)=>b.month.localeCompare(a.month)||b.units-a.units||a.vendor.localeCompare(b.vendor));
}
