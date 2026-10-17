import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const MAX_RAW_BYTES=8*1024*1024;
async function optionalJson(file) {
  try {return JSON.parse(await fs.readFile(file,'utf8'));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
function dateValue(value) {const n=Date.parse(value || '');return Number.isFinite(n)?n:0;}
function validateEntry(entry,seen) {
  if(!entry || typeof entry.file!=='string' || !/^[a-zA-Z0-9_.-]+\.json\.gz$/.test(entry.file) || entry.file.includes('..'))throw new Error('Invalid portable inventory chunk path');
  if(seen.has(entry.file))throw new Error('Duplicate portable inventory chunk');
  seen.add(entry.file);
  if(!/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes<=0 || entry.bytes>MAX_RAW_BYTES || !Number.isSafeInteger(entry.rawBytes) || entry.rawBytes<=0 || entry.rawBytes>MAX_RAW_BYTES)throw new Error('Invalid portable inventory chunk metadata');
}

export async function readPortableInventory(directory,manifest) {
  if(manifest?.format!=='inventory-portable-source' || manifest.formatVersion!==1 || !dateValue(manifest.generatedAt) || !manifest.arrays || typeof manifest.arrays!=='object' || Array.isArray(manifest.arrays))throw new Error('Invalid portable inventory manifest');
  if(!manifest.counts || typeof manifest.counts!=='object' || Array.isArray(manifest.counts) || JSON.stringify(Object.keys(manifest.counts).sort())!==JSON.stringify(Object.keys(manifest.arrays).sort()))throw new Error('Invalid portable inventory row counts');
  const seen=new Set();
  validateEntry(manifest.base,seen);
  for(const [key,entries] of Object.entries(manifest.arrays)) {
    if(!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || ['constructor','prototype'].includes(key) || !Array.isArray(entries))throw new Error('Invalid portable inventory array');
    if(!Number.isSafeInteger(manifest.counts[key]) || manifest.counts[key]<0)throw new Error('Invalid portable inventory row count');
    for(const entry of entries)validateEntry(entry,seen);
  }
  async function readChunk(entry) {
    const file=path.join(directory,entry.file);
    const stat=await fs.stat(file);
    if(stat.size!==entry.bytes)throw new Error(`Portable inventory chunk size mismatch: ${entry.file}`);
    const bytes=await fs.readFile(file);
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`Portable inventory checksum mismatch: ${entry.file}`);
    const raw=gunzipSync(bytes,{maxOutputLength:MAX_RAW_BYTES});
    if(raw.length!==entry.rawBytes)throw new Error(`Portable inventory decoded size mismatch: ${entry.file}`);
    return JSON.parse(raw.toString('utf8'));
  }
  const data=await readChunk(manifest.base);
  if(!data || typeof data!=='object' || Array.isArray(data) || data.meta?.generatedAt!==manifest.generatedAt)throw new Error('Portable inventory base does not match the manifest');
  for(const [key,entries] of Object.entries(manifest.arrays)) {
    const rows=[];
    for(const entry of entries) {
      const part=await readChunk(entry);
      if(!Array.isArray(part))throw new Error(`Portable inventory ${key} chunk is not an array`);
      for(const row of part)rows.push(row);
    }
    if(manifest.counts[key]!==rows.length)throw new Error(`Portable inventory ${key} row count mismatch`);
    data[key]=rows;
  }
  return data;
}

// A newer synchronized legacy file can supersede a previously imported export.
// Corrupt imported manifests/chunks fail instead of silently showing old data.
export async function readInventorySource({root=process.cwd(),legacyFile=path.join(root,'data/inventory_actuals.json'),allowMissing=false}={}) {
  const directory=path.join(root,'data/shopify-export');
  const manifest=await optionalJson(path.join(directory,'manifest.json'));
  const legacy=await optionalJson(legacyFile);
  if(manifest) {
    const portable=await readPortableInventory(directory,manifest);
    return legacy && dateValue(legacy.meta?.generatedAt)>dateValue(portable.meta?.generatedAt)?legacy:portable;
  }
  if(legacy)return legacy;
  if(allowMissing)return null;
  throw new Error('Inventory data not found. Copy data/shopify-export/ from the extraction workflow, or provide data/inventory_actuals.json.');
}
