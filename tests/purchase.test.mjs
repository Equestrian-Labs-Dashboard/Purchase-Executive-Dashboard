import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateDatedCohorts} from '../scripts/cohort-allocation.mjs';
import {receiptGroups,receiptTotals,selectedPerformance,periodRange,completeCoverage} from '../assets/js/purchaseCore.mjs';
import {emptyPlan,carryForward,validatePlan,nextMonth} from '../assets/js/priorities.mjs';
const item={store:'corro',vendor:'Vendor A',sku:'TEST',variantId:'v1',inventoryItemId:'i1',currency:'USD',retailCurrency:'USD',unitCost:10,retailPrice:15};
const receipt=(date,units,id)=>({...item,receiptId:id,cohortDate:date,receivedAt:date,unitsReceived:units,cohortType:'receipt',dateBasis:'received',costBasis:'purchase_order_cost'});
const c={status:'success',start:'2026-06-01',end:'2026-06-30',costMetric:'cost_of_goods_sold',financialMetrics:['netSales','grossSales','discounts']};
const coverage=Object.fromEntries([6,7,8,9,10].map(m=>[`2026-${String(m).padStart(2,'0')}`,{...c,start:`2026-${String(m).padStart(2,'0')}-01`,end:`2026-${String(m).padStart(2,'0')}-${m===6||m===9?'30':'31'}`} ]));
function fixture(receipts,sales=[]){return {meta:{startDate:'2026-06-01',stores:{corro:{salesThrough:'2026-10-13',salesDailyCoverage:structuredClone(coverage)}}},asOf:'2026-10-13',receipts,sales,catalog:[]};}
const filters={store:'all',brand:'all',vendor:'all',type:'month',period:'2026-07'};
test('FIFO protects opening stock and allocates each sale only once across receipts',()=>{
  const receipts=[receipt('2026-07-01',10,'r1'),receipt('2026-07-02',10,'r2')],sales=[{...item,soldAt:'2026-07-03',units:17,netUnits:17}];
  const result=allocateDatedCohorts({shop:{key:'corro'},receipts,sales,catalog:[item],openingHistory:[{...item,month:'2026-06',startingUnits:5}],startDate:'2026-06-01'});
  assert.equal(result.cohorts[0].soldWithinDays[30],10);assert.equal(result.cohorts[1].soldWithinDays[30],2);
  const groups=receiptGroups(fixture(result.cohorts),filters),totals=receiptTotals(groups);assert.equal(totals.units,20);assert.equal(totals.sold90,12);assert.equal(totals.rate90,60);assert.equal(totals.cost,200);assert.equal(totals.markup,50);
});
test('30-day window includes day 29, excludes day 30; 90 cumulative and monotonic',()=>{
  const sales=['2026-07-30','2026-07-31','2026-09-28','2026-09-29'].map(soldAt=>({...item,soldAt,units:1}));
  const {cohorts}=allocateDatedCohorts({shop:{key:'corro'},receipts:[receipt('2026-07-01',10,'r')],sales,catalog:[item],openingHistory:[{...item,month:'2026-06',startingUnits:0}],startDate:'2026-06-01'});
  assert.deepEqual(cohorts[0].soldWithinDays,{30:1,60:2,90:3});
});
test('maturity and missing opening stock never become false zero percentages',()=>{
  const r={...receipt('2026-10-01',10,'r'),soldWithinDays:{30:3,60:3,90:3}};const d=fixture([r]);
  const g=receiptGroups(d,{...filters,period:'2026-10'})[0];assert.equal(g.windows[30].status,'pending');assert.equal(g.windows[30].units,3);assert.equal(g.remaining90,null);
  r.soldWithinDays={};assert.equal(receiptGroups(d,{...filters,period:'2026-10'})[0].windows[30].status,'unavailable');
});
test('a gap before receipt blocks FIFO percentage even when its window is covered',()=>{
  const r={...receipt('2026-07-01',10,'r'),soldWithinDays:{30:3,60:3,90:3}};const d=fixture([r]);delete d.meta.stores.corro.salesDailyCoverage['2026-06'];assert.equal(receiptGroups(d,filters)[0].windows[30].status,'unavailable');
});
test('catalog cost cannot become receipt COGS and mixed currency totals are withheld',()=>{
  const a={...receipt('2026-07-01',10,'r'),costBasis:'current_shopify_cost',soldWithinDays:{30:0,60:0,90:0}};assert.equal(receiptGroups(fixture([a]),filters)[0].cost,null);
  const b={...a,cohortDate:'2026-07-02',receivedAt:'2026-07-02',costBasis:'purchase_order_cost',currency:'EUR'};a.costBasis='purchase_order_cost';assert.equal(receiptTotals(receiptGroups(fixture([a,b]),filters)).cost,null);
});
test('customer restocks are excluded even if incorrectly labelled as receipt',()=>{const r={...receipt('2026-07-01',10,'r'),sourceReason:'restock'};assert.equal(receiptGroups(fixture([r]),filters).length,0);});
test('receipt markup requires retail and receipt costs in the same known currency',()=>{const r={...receipt('2026-07-01',10,'r'),retailCurrency:'EUR'};assert.equal(receiptGroups(fixture([r]),filters)[0].markup,null);});
test('financial metrics use reported net sales after discounts exactly once',()=>{const d=fixture([],[{...item,soldAt:'2026-07-01',quantityOrdered:10,netUnits:9,netSales:100,costOfGoodsSold:60,discounts:-20}]);const p=selectedPerformance(d,filters);assert.equal(p.grossProfit,40);assert.equal(p.cost,60);assert.equal(p.net,9);delete d.meta.stores.corro.salesDailyCoverage['2026-07'].financialMetrics;assert.equal(selectedPerformance(d,filters).grossProfit,null);});
test('YTD never claims missing Jan–May; vendor, store and brand filters are independent',()=>{assert.deepEqual(periodRange('ytd','2026','2026-10-13'),{start:'2026-01-01',end:'2026-10-13'});assert.equal(completeCoverage(fixture([]).meta.stores.corro,'2026-01-01','2026-10-13'),false);const a={...receipt('2026-07-01',5,'r'),brand:'Brand X'};assert.equal(receiptGroups(fixture([a]),{...filters,brand:'Brand Y'}).length,0);assert.equal(receiptGroups(fixture([a]),{...filters,brand:'Brand X'}).length,1);});
test('plans carry unfinished rows once, retain source results and protect full targets',()=>{const a=emptyPlan('2026-12'),b=emptyPlan('2027-01');a.rows[0].priority='Buy';a.rows[0].results='reviewed';a.rows[1].priority='Done';a.rows[1].status='Done';const copied=carryForward(a,b);assert.equal(copied.rows.filter(r=>r.priority).length,1);assert.equal(copied.rows[0].results,'');assert.equal(a.rows[0].results,'reviewed');assert.deepEqual(carryForward(a,copied),copied);b.rows.forEach(r=>r.priority='Already planned');assert.throws(()=>carryForward(a,b),/free slots/);assert.equal(nextMonth('2026-12'),'2027-01');});
test('plans reject invalid goals, duplicate identities and Owner is not persisted',()=>{const p=emptyPlan('2026-07');p.rows[0].owner='obsolete';assert.equal(validatePlan(p).rows[0].owner,undefined);p.rows[0].sellThrough='101';assert.throws(()=>validatePlan(p),/numeric/);p.rows[0].sellThrough='';p.rows[1].id=p.rows[0].id;assert.throws(()=>validatePlan(p),/identity/);});
test('import pads five slots and carry protects previously populated blank identities',()=>{const a=emptyPlan('2026-07'),b=emptyPlan('2026-08');a.rows[0].priority='Incoming';b.rows[2].id='2026-08-blank-2';b.rows[2].priority='Existing';const result=validatePlan(carryForward(a,b));assert.equal(new Set(result.rows.map(r=>r.id)).size,5);assert.equal(result.rows.filter(r=>r.priority).length,2);assert.equal(validatePlan({...a,rows:a.rows.slice(0,1)}).rows.length,5);});
