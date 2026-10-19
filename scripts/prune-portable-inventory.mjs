/** Remove obsolete *compressed* public chunks only after an atomic manifest exists.
 * Never deletes the current chunks, raw receipts CSVs or any unrelated data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.env.INVENTORY_EXPORT_DIR||'data/shopify-export');
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
if(manifest.format!=='inventory-portable-source'||manifest.formatVersion!==1)throw Error('Unknown portable manifest');
const active=new Set([manifest.base.file,...Object.values(manifest.arrays).flat().map(e=>e.file)]);
if([...active].some(f=>!/^[\w-]+_[a-f0-9]{64}\.json\.gz$/.test(f)))throw Error('Invalid active compressed chunk name');
let removed=0;
for(const name of await fs.readdir(root)){
 if(name.endsWith('.json.gz')&&!active.has(name)){
  if(!/^[\w-]+_[a-f0-9]{64}\.json\.gz$/.test(name))throw Error(`Unexpected chunk name: ${name}`);
  await fs.rm(path.join(root,name));removed++;
 }
}
console.log(`Pruned ${removed} obsolete portable chunks, retained ${active.size} verified chunks.`);
