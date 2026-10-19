import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceMetrics} from '../assets/js/sourceMetrics.mjs';
const monthly=(month,endingUnits,endingValue)=>({store:'corro',month,vendor:'Vendor A',brand:'Brand A',category:'Saddles',currency:'USD',startingUnits:20,endingUnits,unitsSold:5,endingValue,missingValueRows:0});
const sale=(date,value,cost)=>({store:'corro',vendor:'Vendor A',brand:'Brand A',category:'Saddles',currency:'USD',soldAt:date,netUnits:2,quantityOrdered:3,netSales:value,costOfGoodsSold:cost});
const data={asOf:'2026-08-19',meta:{startDate:'2026-06-01',stores:{corro:{salesThrough:'2026-08-19',salesDailyCoverage:{'2026-07':{status:'success',start:'2026-07-01',end:'2026-07-31'},'2026-08':{status:'success',start:'2026-08-01',end:'2026-08-19'}}}}},sales:[sale('2026-07-02',120,60),sale('2026-07-03',80,null)],monthly:[monthly('2026-07',25,900),monthly('2026-08',40,2000)],catalog:[{store:'corro',vendor:'Vendor A',brand:'Brand A',category:'Saddles',currency:'USD',currentUnits:8,unitCost:10,retailPrice:20},{store:'corro',vendor:'Vendor A',brand:'Brand A',category:'Saddles',currency:'USD',currentUnits:2,unitCost:null,retailPrice:null}]};
const filters={store:'corro',vendor:'all',brand:'all',category:'all',type:'month',period:'2026-07'};
test('real imported monthly revenue survives incomplete cost, but margin uses the same matched rows',()=>{
 const p=sourceMetrics(data,filters);
 assert.equal(p.netSales,200);assert.equal(p.quantityOrdered,6);assert.equal(p.netUnits,4);
 assert.equal(p.costCoveredRows,1);assert.equal(p.salesRows,2);assert.equal(p.fullyCostCovered,false);
 assert.equal(p.matchedCogs,60);assert.equal(p.matchedNetSales,120);assert.equal(p.grossProfitMatched,60);assert.equal(p.grossMarginMatched,50);
});
test('historical month ending value and units are from selected month, never latest stock',()=>{
 const p=sourceMetrics(data,filters);assert.equal(p.snapshotMonth,'2026-07');assert.equal(p.endingUnits,25);assert.equal(p.endingValue,900);
 const q=sourceMetrics(data,{...filters,type:'quarter',period:'2026-Q3'});
 assert.equal(q.snapshotMonth,'2026-08');assert.equal(q.endingUnits,40);assert.equal(q.endingValue,2000);
});
test('catalog markup is based only on costed and priced current units, not supplier receipts',()=>{
 const p=sourceMetrics(data,filters);assert.equal(p.catalogMarkup,100);assert.equal(p.valuedUnits,8);assert.equal(p.holdingUnits,10);
 assert.equal(p.retailSubset,160);assert.equal(p.pricedUnits,8);
});
test('missing or mixed-currency amounts never become a fabricated financial total',()=>{
 const broken={...data,sales:[{...data.sales[0],currency:'USD'},{...data.sales[1],currency:'EUR'}]};
 const p=sourceMetrics(broken,filters);assert.equal(p.netSales,null);assert.equal(p.matchedCogs,null);
 const incomplete={...data,monthly:[{...data.monthly[0],missingValueRows:1},data.monthly[1]]};
 assert.equal(sourceMetrics(incomplete,filters).endingValue,null);
});
test('missing daily sales coverage cannot falsely show an exact revenue total',()=>{
 const p=sourceMetrics({...data,meta:{startDate:'2026-06-01',stores:{corro:{salesThrough:'2026-08-19',salesDailyCoverage:{}}}}},filters);
 assert.equal(p.netSales,null);assert.equal(p.quantityOrdered,null);assert.equal(p.matchedCogs,null);
});
