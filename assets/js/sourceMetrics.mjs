import {periodRange, matches, completeCoverage} from './purchaseCore.mjs';

const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const total = (rows, key) => rows.reduce((sum,row)=>sum+Number(row[key]),0);
const oneCurrency = rows => {
  const currencies = [...new Set(rows.map(row=>row.currency).filter(Boolean))];
  return currencies.length===1 && rows.every(row=>row.currency===currencies[0]) ? currencies[0] : null;
};

// Genuine Shopify sales and stock snapshots. Financial calculations restricted to
// rows with matching data; missing values are never treated as zero.
export function sourceMetrics(data, filters) {
  const range=periodRange(filters.type,filters.period,data.asOf);
  const through=data.meta.stores.corro?.salesThrough||data.asOf;
  const end=range.end<through?range.end:through;
  const coverage=range.start<=end&&completeCoverage(data.meta.stores.corro,range.start,end);
  const sales=(data.sales||[]).filter(r=>r.store==='corro'&&matches(r,filters)&&r.soldAt>=range.start&&r.soldAt<=end);
  const salesCurrency=oneCurrency(sales);
  const allUnits=coverage&&sales.length>0&&sales.every(r=>numeric(r.netUnits)&&numeric(r.quantityOrdered));
  const completeNetSales=coverage&&salesCurrency&&sales.length>0&&sales.every(r=>numeric(r.netSales));
  const costCovered=coverage&&salesCurrency?sales.filter(r=>numeric(r.netSales)&&numeric(r.costOfGoodsSold)):[];
  const matchedNetSales=costCovered.length?total(costCovered,'netSales'):null;
  const matchedCogs=costCovered.length?total(costCovered,'costOfGoodsSold'):null;
  const grossProfitMatched=matchedNetSales!==null&&matchedCogs!==null?matchedNetSales-matchedCogs:null;
  const grossMarginMatched=matchedNetSales>0&&grossProfitMatched!==null?100*grossProfitMatched/matchedNetSales:null;
  const fullyCostCovered=coverage&&sales.length>0&&costCovered.length===sales.length;

  // A monthly inventory snapshot is for ONE MONTH only. Never add stock on hand
  // across June+July or confuse the newest stock with historical month-end stock.
  const months=[...new Set((data.monthly||[]).filter(r=>r.store==='corro'&&r.month>='2026-01'&&r.month+'-01'>=range.start&&r.month+'-01'<=end).map(r=>r.month))].sort();
  const snapshotMonth=months.at(-1)||null;
  const endingRows=(data.monthly||[]).filter(r=>r.store==='corro'&&r.month===snapshotMonth&&matches(r,filters));
  const endingCurrency=oneCurrency(endingRows);
  const endingUnits=endingRows.length&&endingRows.every(r=>numeric(r.endingUnits))?total(endingRows,'endingUnits'):null;
  const endingValue=endingRows.length&&endingCurrency&&endingCurrency!=='Unknown'&&endingRows.every(r=>numeric(r.endingValue)&&Number(r.missingValueRows||0)===0)?total(endingRows,'endingValue'):null;

  // Historical receipt costs are NOT the same as the current catalog unit cost.
  // Report catalog markup and priced holdings as explicitly current, partial
  // context only, never as verified purchase-order financial performance.
  const stock=(data.catalog||[]).filter(r=>r.store==='corro'&&matches(r,filters)&&numeric(r.currentUnits)&&Number(r.currentUnits)>0);
  const holdingUnits=stock.reduce((sum,r)=>sum+Number(r.currentUnits),0);
  const priced=stock.filter(r=>numeric(r.retailPrice)&&Number(r.retailPrice)>0&&!!r.currency);
  const pricedCurrency=oneCurrency(priced);
  const retailSubset=pricedCurrency&&priced.length?priced.reduce((sum,r)=>sum+Number(r.currentUnits)*Number(r.retailPrice),0):null;
  const pricedUnits=priced.reduce((sum,r)=>sum+Number(r.currentUnits),0);
  const costAndRetail=stock.filter(r=>numeric(r.unitCost)&&Number(r.unitCost)>0&&numeric(r.retailPrice)&&Number(r.retailPrice)>0&&!!r.currency);
  const basisCurrency=oneCurrency(costAndRetail);
  const catalogCost=costAndRetail.reduce((sum,r)=>sum+Number(r.currentUnits)*Number(r.unitCost),0);
  const catalogRetail=costAndRetail.reduce((sum,r)=>sum+Number(r.currentUnits)*Number(r.retailPrice),0);
  const catalogMarkup=basisCurrency&&catalogCost>0?(catalogRetail/catalogCost-1)*100:null;
  const valuedUnits=costAndRetail.reduce((sum,r)=>sum+Number(r.currentUnits),0);
  return {
    range,end,coverage,salesRows:sales.length,salesCurrency,
    quantityOrdered:allUnits?total(sales,'quantityOrdered'):null,
    netUnits:allUnits?total(sales,'netUnits'):null,
    netSales:completeNetSales?total(sales,'netSales'):null,
    costCoveredRows:costCovered.length,costCoveredUnits:costCovered.reduce((sum,r)=>sum+(numeric(r.netUnits)?Number(r.netUnits):0),0),
    fullyCostCovered,matchedNetSales,matchedCogs,grossProfitMatched,grossMarginMatched,
    snapshotMonth,endingUnits,endingValue,endingCurrency,
    holdingUnits,retailSubset,pricedCurrency,pricedUnits,
    catalogMarkup,catalogMarkupCurrency:basisCurrency,valuedUnits,
  };
}
