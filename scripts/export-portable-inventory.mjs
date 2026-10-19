import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {readInventorySource} from './inventory-source.mjs';

const DEFAULT_TARGET_BYTES = 2 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function isoDate(value, label) {
  const raw = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${label} must be an ISO date`);
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== raw) throw new Error(`${label} must be a valid date`);
  return raw;
}

function monthsBetween(start, end) {
  const months = [];
  let cursor = start.slice(0, 7);
  const last = end.slice(0, 7);
  while (cursor <= last) {
    months.push(cursor);
    const [year, month] = cursor.split('-').map(Number);
    cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
  }
  return months;
}

/** A transfer must not make an incomplete Shopify refresh look publishable. */
export function validatePortableInventory(data) {
  const meta = data?.meta;
  if (!meta || meta.status !== 'ok' || !Number.isFinite(Date.parse(meta.generatedAt))) throw new Error('Portable export requires a successful, dated Shopify sync');
  const start = isoDate(meta.historyStartDate || meta.startDate, 'History start');
  const salesStart = isoDate(meta.salesSyncFrom || meta.startDate, 'Sales start');
  if (!Array.isArray(data.monthlyInventory)) throw new Error('Portable export requires monthly inventory history');
  const rowMonths = new Set(data.monthlyInventory.map(row => `${row?.store}|${row?.month}`));
  const requiredStores=String(process.env.INVENTORY_REQUIRED_STORES||'corro,cavali').split(',').map(x=>x.trim()).filter(Boolean);
  if(!requiredStores.length||requiredStores.some(x=>!['corro','cavali'].includes(x)))throw Error('Invalid INVENTORY_REQUIRED_STORES');
  for (const store of requiredStores) {
    const info = meta.stores?.[store];
    if (!info?.ok || info.status !== 'synced') throw new Error(`${store}: a successful Shopify sync is required`);
    if (info.monthlyInventoryError || info.monthlyAdjustmentsError) throw new Error(`${store}: monthly Shopify history is incomplete`);
    const through = isoDate(info.salesThrough, `${store} salesThrough`);
    if (through < start || through < salesStart) throw new Error(`${store}: reporting interval is invalid`);
    for (const month of monthsBetween(start, through)) {
      if (!rowMonths.has(`${store}|${month}`)) throw new Error(`${store} ${month}: monthly inventory history is missing`);
      const coverage = info.nativeDailyCoverage?.[month];
      if (!coverage || !['success', 'cached'].includes(coverage.status) || (coverage.source === 'manual_shopifyql_csv' && !info.manualCsvImportedMonths?.includes(month))) throw new Error(`${store} ${month}: dated inventory adjustments are incomplete`);
    }
    for (const month of monthsBetween(salesStart, through)) {
      const coverage = info.salesDailyCoverage?.[month];
      if (coverage?.status !== 'success' || !['shopifyql_sales', 'manual_shopifyql_csv'].includes(coverage.source) || (coverage.source === 'manual_shopifyql_csv' && !info.manualCsvImportedMonths?.includes(month))) throw new Error(`${store} ${month}: daily Shopify sales are incomplete`);
      const expectedStart = month === salesStart.slice(0, 7) ? salesStart : `${month}-01`;
      const [year, monthNumber] = month.split('-').map(Number);
      const expectedEnd = month === through.slice(0, 7) ? through : new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      if (coverage.start !== expectedStart || coverage.end !== expectedEnd) throw new Error(`${store} ${month}: daily Shopify sales do not cover the reporting interval`);
    }
  }
}

/**
 * Preserve the complete source, including private receipt/adjustment arrays.
 * Immutable, content-addressed gzip files make manual GitHub uploads small.
 * The manifest is replaced only after every referenced file exists.
 */
export async function writePortableInventory(data, {outputDir = path.join(process.cwd(), 'data', 'shopify-export'), targetBytes = DEFAULT_TARGET_BYTES, validate = true} = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Inventory source must be an object');
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 2 || targetBytes > 8*1024*1024) throw new RangeError('targetBytes must be an integer between 2 bytes and 8 MiB');
  if (validate) validatePortableInventory(data);
  const destination = path.resolve(outputDir);
  const base = Object.fromEntries(Object.entries(data).filter(([, value]) => !Array.isArray(value)));
  const baseBytes = Buffer.from(JSON.stringify(base));
  if (baseBytes.length > targetBytes) throw new Error(`Inventory metadata exceeds the ${targetBytes}-byte chunk limit`);
  await fs.mkdir(destination, {recursive: true});

  async function writeChunk(label, raw) {
    const compressed = gzipSync(raw, {level: 9});
    const sha256 = digest(compressed);
    const file = `${label}_${sha256}.json.gz`;
    const filename = path.join(destination, file);
    try {
      await fs.writeFile(filename, compressed, {flag: 'wx'});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (digest(await fs.readFile(filename)) !== sha256) throw new Error(`Existing export chunk is corrupt: ${file}`);
    }
    return {file, bytes: compressed.length, rawBytes: raw.length, sha256};
  }

  const manifest = {
    format: 'inventory-portable-source', formatVersion: 1,
    generatedAt: data.meta?.generatedAt ?? null,
    base: await writeChunk('base', baseBytes),
    arrays: Object.create(null), counts: Object.create(null),
  };
  for (const [field, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    const entries = [];
    const label = field.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'array';
    let encodedRows = [], rawBytes = 2;
    async function flush() {
      if (!encodedRows.length) return;
      entries.push(await writeChunk(`${label}_${String(entries.length + 1).padStart(4, '0')}`, Buffer.from(`[${encodedRows.join(',')}]`)));
      encodedRows = [];
      rawBytes = 2;
    }
    for (const row of rows) {
      // JSON arrays serialize undefined entries as null as well.
      const encoded = JSON.stringify(row) ?? 'null';
      const rowBytes = Buffer.byteLength(encoded);
      if (rowBytes + 2 > targetBytes) throw new Error(`${field}: a single row exceeds the ${targetBytes}-byte chunk limit`);
      if (encodedRows.length && rawBytes + rowBytes + 1 > targetBytes) await flush();
      rawBytes += rowBytes + (encodedRows.length ? 1 : 0);
      encodedRows.push(encoded);
    }
    await flush();
    manifest.arrays[field] = entries;
    manifest.counts[field] = rows.length;
  }
  const temporaryManifest = path.join(destination, `.manifest-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
    await fs.rename(temporaryManifest, path.join(destination, 'manifest.json'));
  } finally {
    await fs.rm(temporaryManifest, {force: true});
  }
  return manifest;
}

async function main() {
  const root = process.cwd();
  const outputDir = process.env.INVENTORY_EXPORT_DIR || process.argv[2] || path.join(root, 'data', 'shopify-export');
  const data = process.env.INVENTORY_SOURCE_FILE ? JSON.parse(await fs.readFile(process.env.INVENTORY_SOURCE_FILE,'utf8')) : await readInventorySource({root});
  const manifest = await writePortableInventory(data, {outputDir});
  const entries = [manifest.base, ...Object.values(manifest.arrays).flat()];
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  console.log(`Portable inventory export: ${entries.length} gzip files, ${(bytes / 1024 / 1024).toFixed(2)} MiB; manifest ${path.join(path.resolve(outputDir), 'manifest.json')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Portable inventory export failed: ${error.message}`);
    process.exitCode = 1;
  });
}
