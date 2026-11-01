import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'dist/data/manifest.json'),'utf8'));
let checks=0;
for(const [name,entry] of Object.entries(manifest.files)){
  const bytes=await readFile(path.join(root,'dist/data',name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);
  assert.equal(bytes.length,entry.bytes);assert(bytes.length<25*1024*1024);
  const data=JSON.parse(gunzipSync(bytes));
  assert.deepEqual(data.fields,entry.fields);assert.equal(data.rows,entry.rows);
  for(const col of data.columns)assert.equal(col.length,data.rows);
  assert(!data.fields.some(k=>/customer_id|unique_id|zip_code|latitude|longitude|comment|password|token/.test(k)));
  checks+=7;
}
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else {assert(!/\.(sqlite|db|zip|log)$/i.test(entry.name),'Private file in dist: '+entry.name);checks++;}}}
await walk(path.join(root,'dist'));
for(const name of ['index.html','case.html']){
  const html=await readFile(path.join(root,'dist',name),'utf8');
  assert(!/http:\/\/(localhost|127\.0\.0\.1)/.test(html));
  for(const [,url] of html.matchAll(/(?:href|src)="(\.\/[^"#?]+)(?:[?#][^"]*)?"/g))await readFile(path.resolve(root,'dist',url));
  checks+=2;
}
console.log(JSON.stringify({passed:true,checks,compressedBytes:Object.values(manifest.files).reduce((s,e)=>s+e.bytes,0)},null,2));
