import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateDatedCohorts} from '../scripts/cohort-allocation.mjs';
import {receiptGroups,receiptTotals,selectedPerformance,periodRange,completeCoverage,currentReceiptSkuStock,matches} from '../assets/js/purchaseCore.mjs';
import {emptyPlan,carryForward,validatePlan,nextMonth} from '../assets/js/priorities.mjs';
const item={store:'corro',vendor:'Vendor A',sku:'TEST',variantId:'v1',inventoryItemId:'i1',currency:'USD',retailCurrency:'USD',unitCost:10,retailPrice:15};
const receipt=(date,units,id)=>({...item,receiptId:id,cohortDate:date,receivedAt:date,unitsReceived:units,cohortType:'receipt',dateBasis:'received',costBasis:'purchase_order_cost',openingHistoryAvailable:true,allocationConfidence:'estimated_fifo'});
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
test('plans preserve Owner and Target Date; reject invalid goals and duplicates',()=>{const p=emptyPlan('2026-07');p.rows[0].owner='Tatum';p.rows[0].targetDate='2026-07-31';assert.equal(validatePlan(p).rows[0].owner,'Tatum');assert.equal(validatePlan(p).rows[0].targetDate,'2026-07-31');p.rows[0].sellThrough='101';assert.throws(()=>validatePlan(p),/numeric/);p.rows[0].sellThrough='';p.rows[1].id=p.rows[0].id;assert.throws(()=>validatePlan(p),/identity/);});
test('import pads five slots and carry protects previously populated blank identities',()=>{const a=emptyPlan('2026-07'),b=emptyPlan('2026-08');a.rows[0].priority='Incoming';b.rows[2].id='2026-08-blank-2';b.rows[2].priority='Existing';const result=validatePlan(carryForward(a,b));assert.equal(new Set(result.rows.map(r=>r.id)).size,5);assert.equal(result.rows.filter(r=>r.priority).length,2);assert.equal(validatePlan({...a,rows:a.rows.slice(0,1)}).rows.length,5);});

test('current stock is the latest stock of received SKUs, not units remaining at day 90',()=>{
 const g={store:'corro',vendor:'Vendor A',rows:[{variantId:'v1',sku:'A',unitsReceived:20},{variantId:'v1',sku:'A',unitsReceived:10},{variantId:'v2',sku:'B',unitsReceived:15}]};
 const snapshot=[{store:'corro',vendor:'Vendor A',variantId:'v1',sku:'A',currentUnits:3},{store:'corro',vendor:'Vendor A',variantId:'v2',sku:'B',currentUnits:6},{store:'cavali',vendor:'Vendor A',variantId:'v1',sku:'A',currentUnits:999}];
 assert.equal(currentReceiptSkuStock(snapshot,g),9);
 assert.equal(currentReceiptSkuStock(snapshot.slice(0,1),g),null);
 assert.equal(currentReceiptSkuStock(snapshot, {...g,rows:[{sku:'A'}]}),3);
});
test('monthly unit rotation never adds stock snapshots from quarter/month together',()=>{
 const d=fixture([]);d.catalog=[{...item,currentUnits:5,unitCost:10,retailPrice:15,category:'Saddles'}];
 d.monthly=[{store:'corro',vendor:'Vendor A',brand:'Unspecified',category:'Saddles',month:'2026-07',startingUnits:10,endingUnits:8,unitsSold:9},{store:'corro',vendor:'Vendor A',brand:'Unspecified',category:'Saddles',month:'2026-08',startingUnits:8,endingUnits:6,unitsSold:5}];
 const month=selectedPerformance(d,{...filters,category:'Saddles'});assert.equal(month.monthlyRotation,1);
 assert.equal(month.currentStockUnits,5);assert.equal(month.inventoryCost,50);assert.equal(month.inventoryRetail,75);
 assert.equal(selectedPerformance(d,{...filters,category:'Boots'}).currentStockUnits,null);
 assert.equal(selectedPerformance(d,{...filters,type:'quarter',period:'2026-Q3'}).monthlyRotation,null);
 assert.equal(matches({...item,category:'Saddles'},{...filters,category:'Boots'}),false);
});
test('gross margin and discounts require independently validated Shopify financial fields',()=>{
 const d=fixture([],[{...item,soldAt:'2026-07-02',quantityOrdered:4,netUnits:3,netSales:90,grossSales:120,discounts:-30,costOfGoodsSold:54}]);
 const p=selectedPerformance(d,filters);assert.equal(p.grossProfit,36);assert.equal(p.grossMargin,40);assert.equal(p.discountPct,25);
 delete d.meta.stores.corro.salesDailyCoverage['2026-07'].financialMetrics;
 assert.equal(selectedPerformance(d,filters).discountPct,null);
});

test('remaining 90-day cohort units use documented receipt FIFO, not current Shopify SKU stock',()=>{
 const a={...receipt('2026-07-01',8,'r1'),soldWithinDays:{30:2,60:4,90:6},openingHistoryAvailable:true,allocationConfidence:'estimated_fifo'};
 const b={...receipt('2026-07-01',12,'r2'),soldWithinDays:{30:1,60:3,90:7},openingHistoryAvailable:true,allocationConfidence:'estimated_fifo'};
 const d=fixture([a,b]);d.catalog=[{...item,currentUnits:1000}];
 const group=receiptGroups(d,filters)[0];
 assert.equal(group.units,20);
 assert.equal(group.windows[90].status,'ready');
 assert.equal(group.windows[90].units,13);
 assert.equal(group.remaining90,7);
 assert.equal(group.remainingCost90,70);
 assert.equal(group.retail,300);
});

test('pending 90 days and current-cost cohorts do not fake financial remaining value',()=>{
 const recent={...receipt('2026-10-01',10,'r'),soldWithinDays:{30:1,60:1,90:1}};
 const pending=receiptGroups(fixture([recent]),{...filters,period:'2026-10'})[0];
 assert.equal(pending.windows[90].status,'pending');
 assert.equal(pending.remaining90,null);
 assert.equal(pending.remainingCost90,null);
 const historical={...receipt('2026-07-01',10,'r'),costBasis:'current_item_cost',soldWithinDays:{30:2,60:2,90:3}};
 const settled=receiptGroups(fixture([historical]),filters)[0];
 assert.equal(settled.remaining90,7);
 assert.equal(settled.cost,null);
 assert.equal(settled.remainingCost90,null);
});


test('older action plan rows migrate Owner and Target Date safely without losing KPI goals',()=>{
 const original=emptyPlan('2026-09');
 for(const row of original.rows){delete row.owner;delete row.targetDate;}
 original.rows[0].markup='54';original.rows[0].successLooksLike='Margin ≥ 50%';
 const migrated=validatePlan(original);
 assert.equal(migrated.rows[0].owner,'');
 assert.equal(migrated.rows[0].targetDate,'');
 assert.equal(migrated.rows[0].markup,'54');
 assert.equal(migrated.rows[0].successLooksLike,'Margin ≥ 50%');
 migrated.rows[0].targetDate='2026-09-31';
 assert.throws(()=>validatePlan(migrated),/target date/);
});

test('carrying action plans forward preserves owner but resets an outdated due date',()=>{
 const source=emptyPlan('2026-07'), target=emptyPlan('2026-08');
 source.rows[0].priority='Vendor restock';source.rows[0].owner='Tatum';source.rows[0].targetDate='2026-07-31';
 const result=carryForward(source,target);
 assert.equal(result.rows[0].owner,'Tatum');
 assert.equal(result.rows[0].targetDate,'');
});
