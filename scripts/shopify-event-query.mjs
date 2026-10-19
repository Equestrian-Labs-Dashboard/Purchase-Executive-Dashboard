/** Adaptive ShopifyQL inventory-adjustment query builder.
 * Each fallback is less expensive, while retaining the exact date, variant and
 * signed adjustment amount. Missing inventory state/reference is NEVER treated
 * as proof of a supplier purchase.
 */
// Retain customer restocks for the movement audit; the native parser keeps them
// separate from supplier receipts. movement_received needs a purchase reference.
export const RECEIPT_REASON_FILTER = ['restock','purchase','received','movement_received','purchase_order_received'];
export function adjustmentQuery(range, {offset=0,limit=1000,tier=0}={}) {
  const args = [
    {dims:['day','product_variant_id','inventory_change_reason','inventory_state','reference_document_type','reference_document_uri'],where:true},
    {dims:['day','product_variant_id','inventory_change_reason','inventory_state','reference_document_uri'],where:true},
    {dims:['day','product_variant_id','inventory_change_reason','inventory_state','reference_document_type'],where:true},
    {dims:['day','product_variant_id','inventory_change_reason','inventory_state'],where:true},
    {dims:['day','product_variant_id','inventory_change_reason'],where:true},
    {dims:['day','product_variant_id','inventory_change_reason'],where:false},
  ];
  const spec=args[tier];
  if(!spec)throw new RangeError(`Unknown ShopifyQL fallback tier ${tier}`);
  const where=spec.where ? `WHERE inventory_change_reason IN (${RECEIPT_REASON_FILTER.map(reason=>`'${reason}'`).join(', ')})` : '';
  return `FROM inventory_adjustment_history\nSHOW inventory_adjustment_change\n${where}\nGROUP BY ${spec.dims.join(', ')}\nHAVING inventory_adjustment_change > 0\nSINCE ${range.start} UNTIL ${range.end}\nORDER BY ${spec.dims.map(x=>`${x} ASC`).join(', ')}\nLIMIT ${limit} OFFSET ${offset}`;
}
export function normalizeEventQueryRows(page) {
  if(!page || !Array.isArray(page.rows))throw new Error('ShopifyQL inventory adjustment response has no rows array');
  return page.rows;
}
