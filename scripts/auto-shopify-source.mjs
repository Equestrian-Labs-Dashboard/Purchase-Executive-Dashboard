/** Separately orchestrated ShopifyQL purchase/restock evidence and PO-linked receipts.
 * Caller injects gql/shopifyql to keep all network work server-side.
 */
import {parseInventoryAddition, normalizeInventoryEvent, consolidateNativeEvents, purchaseLinkedShipments, deduplicateAgainstVerified} from './shopify-native-receipts.mjs';
import {adjustmentQuery,normalizeEventQueryRows} from './shopify-event-query.mjs';

const iso = value => String(value || '').slice(0, 10);
const asGid = (kind, value) => {
  const raw=String(value??'');
  return raw.startsWith('gid://')?raw:/^\d+$/.test(raw)?`gid://shopify/${kind}/${raw}`:raw;
};

export async function readShopifyRestockEvidence({shop,token,catalog,startDate,ranges,previousEvents=[],monthlySignals={},shopifyql,pageSize=1000}) {
  const byVariant=new Map(catalog.filter(r=>r.variantId).map(r=>[r.variantId,r]));
  const output=[];
  const warnings=[];
  const coverage={};
  const currentMonth=new Date().toISOString().slice(0,7);
  for(const range of ranges){
    const cached=previousEvents.filter(r=>r.store===shop.key && r.cohortMonth===range.month).map(normalizeInventoryEvent);
    if(range.month<currentMonth && cached.length){
      output.push(...cached);
      coverage[range.month]={status:'cached',events:cached.length};
      continue;
    }
    let monthEvents=[];
    const expectEvent=Number(monthlySignals[range.month]||0)>0;
    let success=false;
    let lastError='';
    // ShopifyQL supports these dimensions, but not all combinations are
    // available on every store/version. Retry progressively smaller query
    // shapes, retaining the exact day rather than using monthly totals.
    for(let tier=0;tier<=5;tier++){
      const found=[];
      let failed=false;
      for(let offset=0;offset<50000;offset+=pageSize){
        try {
          const query=adjustmentQuery(range,{offset,limit:pageSize,tier});
          const page=await shopifyql(shop,token,query);
          const rows=normalizeEventQueryRows(page);
          for(const row of rows){
            const event=parseInventoryAddition({
              ...row, product_variant_id:asGid('ProductVariant',row.product_variant_id),
            },shop,byVariant,startDate);
            if(event)found.push(event);
          }
          if(rows.length<pageSize){success=true;break;}
          if(offset+pageSize>=50000){lastError='More than 50,000 adjustment rows. Cannot certify completeness';failed=true;}
        }catch(err){lastError=String(err?.message||err);failed=true;break;}
        if(failed)break;
      }
      if(success && !failed){
        // A lighter query may return the events that a complex report omits.
        // Never call a month 'empty' when the established monthly report shows
        // actual purchase/restock adjustments for that same month.
        if(found.length===0 && tier<5){
          // Some ShopifyQL versions return an empty table for a supported but
          // ineffective high-cardinality grouping instead of a parse error.
          success=false;continue;
        }
        monthEvents=consolidateNativeEvents(found);
        if(tier>0)warnings.push(`${shop.label} ${range.month}: daily adjustment query used fallback tier ${tier}; some document/state fields are not available.`);
        break;
      }
      success=false;
      // Never silently mix a partial first query with the next fallback.
    }
    if(success && expectEvent && monthEvents.length===0){
      coverage[range.month]={status:'inconsistent',events:0,monthlySignals:monthlySignals[range.month]};
      warnings.push(`${shop.label} ${range.month}: monthly Shopify adjustments include purchase/restock, but dated queries returned no qualifying events. Rotation unavailable for this month.`);
    }else if(success){
      coverage[range.month]={status:'success',events:monthEvents.length};
      output.push(...monthEvents);
      console.log(`${shop.label}: dated stock additions ${range.month} events=${monthEvents.length}`);
    }else{
      coverage[range.month]={status:'error',error:lastError.slice(0,350)};
      warnings.push(`${shop.label} ${range.month}: all dated inventory adjustment queries failed: ${lastError.slice(0,300)}`);
      if(cached.length)output.push(...cached);
      console.warn(`${shop.label}: dated inventory events ${range.month} FAILED: ${lastError}`);
    }
  }
  return {events:consolidateNativeEvents(output),warnings,coverage,loadedMonths:Object.values(coverage).filter(r=>r.status==='success').length};
}

/** PO -> transfer -> shipment is the only shipment path automatically treated
 * as a supplier purchase; generic inventoryShipments can be internal transfers. */
export async function readPurchaseOrderLinkedShipments({shop,token,purchaseOrders,catalog,startDate,gql,maxLookup=1000}) {
  const receiptPOs=[];
  const purchaseOrderRows=[];
  const warnings=[];
  let lookedUp=0;
  for(const po of purchaseOrders){
    if(lookedUp>=maxLookup){warnings.push(`${shop.label}: purchase order lookup cap reached (${maxLookup}); results incomplete.`);break;}
    lookedUp++;
    try{
      // Shopify InventorySupplierSnapshot has supplierName, NOT supplier{name}.
      // Shopify's GraphQL max query cost also requires page-by-page PO items.
      const metadata=await gql(shop,token,`query POReceipts($id:ID!){inventoryPurchaseOrder(id:$id){id origin{supplierName} transfers(first:100){pageInfo{hasNextPage} nodes{id}}}}`,{id:po.id});
      const details=metadata?.inventoryPurchaseOrder;
      if(!details)continue;
      if(details.transfers?.pageInfo?.hasNextPage){warnings.push(`${shop.label}: PO ${po.name} has more than 100 linked transfers; limited coverage.`);}
      const doc={...po,origin:details.origin,transfers:{nodes:[]},lineItems:{nodes:[]}};
      let afterLine=null;
      do {
        const response=await gql(shop,token,`query POLines($id:ID!,$after:String){inventoryPurchaseOrder(id:$id){lineItems(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id supplierSku title variantTitle totalQuantity unitCost{amount currencyCode} inventoryItem{id sku}}}}}`,{id:po.id,after:afterLine});
        const page=response?.inventoryPurchaseOrder?.lineItems;
        if(!page)break;
        doc.lineItems.nodes.push(...(page.nodes||[]));
        afterLine=page.pageInfo?.hasNextPage?page.pageInfo.endCursor:null;
      }while(afterLine);
      const byInventoryId=new Map(catalog.filter(x=>x.inventoryItemId).map(x=>[x.inventoryItemId,x]));
      const orderedAt=String(po.orderedAt||po.dateCreated||'').slice(0,10);
      for(const line of doc.lineItems.nodes){
        const item=byInventoryId.get(line.inventoryItem?.id);
        const quantity=Number(line.totalQuantity)||0;
        if(!item||quantity<=0||orderedAt<startDate)continue;
        purchaseOrderRows.push({
          receiptId:`po:${po.id}:${line.id}`, source:'shopify_purchase_order',
          sourceLabel:'Shopify purchase order (not proof of receipt)',
          cohortType:'purchase_order',dateBasis:'ordered',
          store:shop.key,storeLabel:shop.label,sourceId:po.name||po.id,
          cohortDate:orderedAt,cohortMonth:orderedAt.slice(0,7),receivedAt:'',
          inventoryItemId:line.inventoryItem?.id,variantId:item.variantId||'',
          sku:item.sku||line.supplierSku||'',vendor:item.vendor||details.origin?.supplierName||'Unknown',
          product:item.product||line.title||'',variant:item.variant||line.variantTitle||'',
          unitsReceived:quantity,unitCost:line.unitCost?.amount==null?0:Number(line.unitCost.amount)||0,
          currency:line.unitCost?.currencyCode||item.currency||'USD',
          costBasis:line.unitCost?.amount==null?'unavailable':'purchase_order_cost',
        });
      }
      for(const transfer of details.transfers?.nodes||[]){
        const t=await gql(shop,token,`query POTransfer($id:ID!){inventoryTransfer(id:$id){id shipments(first:100){pageInfo{hasNextPage} nodes{id}}}}`,{id:transfer.id});
        if(t.inventoryTransfer?.shipments?.pageInfo?.hasNextPage)warnings.push(`${shop.label}: transfer ${transfer.id} has additional shipments not scanned.`);
        const item={id:transfer.id,shipments:{nodes:[]}};
        for(const sh of t.inventoryTransfer?.shipments?.nodes||[]){
          // Avoid deeply nested costly queries and paginate each shipment's items.
          const lines=[];
          let after=null;
          let details=null;
          do{
            const response=await gql(shop,token,`query ReceivedShipment($id:ID!,$after:String){inventoryShipment(id:$id){id dateReceived status lineItems(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id acceptedQuantity inventoryItem{id sku}}}}}`,{id:sh.id,after});
            details=response.inventoryShipment;
            if(!details)break;
            lines.push(...(details.lineItems?.nodes||[]));
            after=details.lineItems?.pageInfo?.hasNextPage?details.lineItems.pageInfo.endCursor:null;
          }while(after);
          if(details)item.shipments.nodes.push({...details,lineItems:{nodes:lines}});
        }
        doc.transfers.nodes.push(item);
      }
      receiptPOs.push(doc);
    }catch(e){warnings.push(`${shop.label}: linked PO shipment lookup for ${po.name||po.id}: ${e.message}`);}
  }
  return {rows:purchaseLinkedShipments(receiptPOs,catalog,startDate),purchaseOrderRows,warnings};
}

export { deduplicateAgainstVerified };
