/**
 * Automatic, read-only analysis of Shopify inventory events. Never classifies a
 * manual adjustment, return, stock transfer or an undated PO as a supplier purchase.
 * Observed restocks are SEPARATE from confirmed purchase receipts.
 */
const str = value => String(value ?? '').trim();
const norm = value => str(value).toLowerCase().replace(/[\s_-]+/g, '');
const amount = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const date = value => {
  const v = str(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : '';
};
const asGid = (kind, id) => {
  const v = str(id);
  return v.startsWith('gid://') ? v : /^\d+$/.test(v) ? `gid://shopify/${kind}/${v}` : v;
};
const customerRestockReason = value => {
  const reason = norm(value);
  return ['restock', 'returnrestock', 'customerrestock', 'customerreturn', 'return', 'returned'].includes(reason);
};

/** Repair cached events using their original Shopify reason. Shopify's `restock`
 * reason means customer stock returned to availability, never supplier receipts.
 * The raw quantity remains in unitsReceived for private export compatibility;
 * consumers select cohortType/dateBasis before allocating purchase cohorts.
 */
export function normalizeInventoryEvent(row) {
  if (!row || typeof row !== 'object') return row;
  if (!customerRestockReason(row.sourceReason || row.inventory_change_reason)
      && row.source !== 'shopify_customer_restock' && row.cohortType !== 'return') return {...row};
  const eventDay = date(row.cohortDate || row.returnedAt || row.receivedAt || row.day);
  const qty = amount(row.unitsReceived ?? row.unitsRestocked ?? row.inventory_adjustment_change);
  const {soldWithinDays, skuOrderedWithinDays, skuNetWithinDays, soldByOffset,
    unitsSold, unitsRemaining, allocationConfidence, allocationMethod, ...event} = row;
  return {
    ...event,
    source: 'shopify_customer_restock', sourceLabel: 'Shopify customer return restocked',
    cohortType: 'return', dateBasis: 'returned', evidenceLevel: 'customer_restock',
    isEstimated: false, cohortDate: eventDay, cohortMonth: eventDay.slice(0, 7),
    receivedAt: '', returnedAt: eventDay, unitsReceived: qty, unitsRestocked: qty,
  };
}

export function classifyInventoryAddition(row) {
  const qty = amount(row.inventory_adjustment_change);
  const state = norm(row.inventory_state);
  const reason = norm(row.inventory_change_reason);
  const refType = norm(row.reference_document_type);
  const refUri = norm(row.reference_document_uri);
  const refCompact = `${refType}|${refUri}`.replace(/[^a-z0-9]/g, '');
  if (!date(row.day) || qty <= 0 || (state && state !== 'available')) return { kind:'ignore', explanation:'Not a dated, positive available-stock event' };
  // A freeform PO-looking reference cannot turn a Shopify customer-return reason
  // into a supplier receipt. Preserve it separately for stock-movement audits.
  if (customerRestockReason(reason)) return {kind:'customer_restock', explanation:'Customer return added back to available inventory'};
  const poRef = /inventorypurchaseorder|supplierpurchaseorder|purchaseorder|poinvoice|supplierreceipt/.test(refCompact);
  // movement_received covers both supplier POs and internal transfers.
  if (reason === 'movementreceived' && (!poRef || state !== 'available')) return {kind:'ignore', explanation:'Received movement is not linked to a supplier purchase'};
  if (/transfer|return|refund|order|cancel|fulfill|correction|damage|count|reconcile|exchange|manual|lost/.test(reason)
      && !/purchaseorder/.test(reason)) return { kind:'ignore', explanation:'Adjustment may not represent a supplier purchase' };
  if (/transfer|return|refund|fulfill|order/.test(refCompact) && !/purchaseorder/.test(refCompact)) return { kind:'ignore', explanation:'Linked to a transfer/return/customer order' };
  if (!/restock|received|purchase/.test(reason)) return { kind:'ignore', explanation:'Not an inbound replenishment reason' };
  if (poRef && state === 'available') return {kind:'confirmed_reference', explanation:'Positive available-stock entry with a documented purchase-order reference'};
  return {kind:'observed_restock', explanation:'Shopify-recorded replenishment, but not a verified supplier purchase'};
}

export function parseInventoryAddition(row, store, catalogByVariant, fromDate) {
  const category = classifyInventoryAddition(row);
  if (category.kind === 'ignore') return null;
  const eventDay = date(row.day);
  if (eventDay < fromDate) return null;
  const variantId = asGid('ProductVariant', row.product_variant_id);
  const catalog = catalogByVariant.get(variantId);
  if (!catalog || !catalog.inventoryItemId || catalog.tracked === false || catalog.requiresShipping === false) return null;
  const qty = amount(row.inventory_adjustment_change);
  const evidenceRef = str(row.reference_document_uri);
  return normalizeInventoryEvent({
    store: store.key, storeLabel: store.label,
    source: category.kind === 'confirmed_reference' ? 'shopify_purchase_reference' : 'shopify_observed_restock',
    sourceLabel: category.kind === 'confirmed_reference' ? 'Shopify purchase-linked stock entry' : 'Shopify observed stock replenishment',
    cohortType: category.kind === 'confirmed_reference' ? 'receipt' : 'restock',
    dateBasis: category.kind === 'confirmed_reference' ? 'received' : 'observed_stock_increase',
    evidenceLevel: category.kind === 'confirmed_reference' ? 'purchase_reference' : 'observed_only',
    isEstimated: category.kind !== 'confirmed_reference',
    sourceReferenceType: str(row.reference_document_type),
    sourceReason: str(row.inventory_change_reason),
    stockStateEvidence: str(row.inventory_state) || 'not_returned',
    historicalPhysicalItem: true,
    sourceDocument: evidenceRef, // retained internally, never exposed in public UI
    cohortDate: eventDay,
    cohortMonth: eventDay.slice(0, 7),
    receivedAt: eventDay,
    inventoryItemId: catalog.inventoryItemId,
    variantId: catalog.variantId || variantId,
    sku: catalog.sku || str(row.product_variant_sku),
    vendor: catalog.vendor || 'Unknown',
    product: catalog.product || '', variant: catalog.variant || '',
    category: catalog.category || '',
    unitsReceived: qty,
    unitCost: amount(catalog.unitCost),
    costBasis: 'current_item_cost',
    retailPrice: amount(catalog.retailPrice),
    currency: catalog.currency || 'USD',
  });
}

export function consolidateNativeEvents(rows) {
  const groups = new Map();
  for (const input of rows) {
    const r = normalizeInventoryEvent(input);
    const key = JSON.stringify([r.store,r.cohortDate,r.variantId || r.inventoryItemId,r.source,r.cohortType,r.dateBasis,r.sourceReferenceType,r.sourceDocument]);
    if (!groups.has(key)) groups.set(key, {...r,receiptId:`shopify:event:${r.store}:${r.cohortDate}:${r.variantId || r.inventoryItemId}:${groups.size}`});
    else {
      groups.get(key).unitsReceived += amount(r.unitsReceived);
      if (r.cohortType === 'return') groups.get(key).unitsRestocked += amount(r.unitsRestocked);
    }
  }
  return [...groups.values()];
}

export function purchaseLinkedShipments(purchaseOrders, catalog, fromDate) {
  const byId = new Map(catalog.filter(x=>x.inventoryItemId).map(x=>[x.inventoryItemId,x]));
  const result = [];
  for (const po of purchaseOrders || []) {
    const supplier = po.origin?.supplierName || '';
    const costs = new Map();
    for (const li of po.lineItems?.nodes || []) {
      const id = li.inventoryItem?.id;
      if (id && li.unitCost?.amount != null) costs.set(id, {cost:amount(li.unitCost.amount),currency:li.unitCost.currencyCode});
    }
    for (const transfer of po.transfers?.nodes || []) {
      for (const shipment of transfer.shipments?.nodes || []) {
        const day = date(shipment.dateReceived);
        if (!day || day < fromDate) continue;
        for (const line of shipment.lineItems?.nodes || []) {
          const received = amount(line.acceptedQuantity);
          if (received <= 0) continue;
          const iid = line.inventoryItem?.id;
          const cat = byId.get(iid);
          if (!cat || cat.tracked === false || cat.requiresShipping === false) continue;
          const price = costs.get(iid);
          result.push({
            receiptId:`shopify:po:${po.id}:${shipment.id}:${line.id}`,sourceId:po.name || po.id,
            historicalPhysicalItem:true,
            source:'shopify_purchase_order_shipment',sourceLabel:'Shopify purchase order linked to received shipment',
            cohortType:'receipt',dateBasis:'received',evidenceLevel:'purchase_order_shipment',isEstimated:false,
            store:cat.store,storeLabel:cat.storeLabel,cohortDate:day,cohortMonth:day.slice(0,7),receivedAt:day,
            inventoryItemId:iid,variantId:cat.variantId || '',sku:line.inventoryItem?.sku || cat.sku || '',
            product:cat.product || '',variant:cat.variant || '',vendor:cat.vendor || supplier || 'Unknown',
            supplier: supplier || null,category:cat.category || '',unitsReceived:received,
            unitCost:price?.cost ?? amount(cat.unitCost),costBasis:price?'purchase_order_cost':'current_item_cost',
            retailPrice:amount(cat.retailPrice),currency:price?.currency || cat.currency || 'USD',
            // dateReceived is initial shipment receipt date, not necessarily each partial delivery date.
            dateAccuracy: String(shipment.status).toUpperCase()==='PARTIALLY_RECEIVED'?'first_received_partial_shipment':'initial_received_at',
          });
        }
      }
    }
  }
  return result;
}

export function deduplicateAgainstVerified(observed, verified) {
  const known = new Map();
  for (const r of verified || []) {
    const key = `${r.store}|${r.cohortDate}|${r.inventoryItemId}`;
    known.set(key,(known.get(key)||0)+amount(r.unitsReceived));
  }
  return (observed || []).flatMap(r=>{
    const key = `${r.store}|${r.cohortDate}|${r.inventoryItemId}`;
    const matching=known.get(key)||0;
    if (!matching) return [r];
    const left=Math.max(0,amount(r.unitsReceived)-matching);
    known.set(key,Math.max(0,matching-amount(r.unitsReceived)));
    return left ? [{...r,unitsReceived:left,receiptId:`${r.receiptId}:unmatched`}] : [];
  });
}
