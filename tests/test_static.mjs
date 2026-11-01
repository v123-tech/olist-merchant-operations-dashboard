import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.resolve(process.argv[2]||path.join(project,'../../olist_project'));
const python=process.env.OLIST_PYTHON||(process.platform==='win32'?'python':'python3');
const reference=spawnSync(python,[path.join(project,'tests/test_static_reference.py'),source],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},maxBuffer:32*1024*1024});
if(reference.status!==0)throw new Error(reference.stderr||reference.error||'Python reference failed');
const expected=JSON.parse(reference.stdout);
const context=vm.createContext({});
vm.runInContext(await readFile(path.join(project,'dist/data-worker.js'),'utf8'),context);
const load=async name=>JSON.parse(name.endsWith('.gz')?gunzipSync(await readFile(path.join(project,'dist/data',name))):await readFile(path.join(project,'dist/data',name),'utf8'));
const [orders,items,meta,config]=await Promise.all(['orders.json.gz','items.json.gz','meta.json','config.json'].map(load));
assert.equal(orders.rows,99441);assert.equal(items.rows,112650);
assert(!orders.fields.some(k=>/customer_(id|unique_id|zip_code)|review_comment|latitude|longitude/.test(k)));
const engine=context.OlistEngine.createEngine(orders,items,meta,config);
// Compare serialized values because VM objects have a different prototype.
const plain=value=>JSON.parse(JSON.stringify(value));
let checks=2;
for(const test of expected.cases){
  if(test.error){assert.throws(()=>engine.query(test.path,test.query),e=>e.code===test.error,`${test.path} ${JSON.stringify(test.query)}`);}
  else{assert.deepEqual(plain(engine.query(test.path,test.query)),test.expected,`${test.path} ${JSON.stringify(test.query)}`);}
  checks++;
}
for(const test of expected.boundaries){
  const view=context.OlistEngine.atTime(test.row,test.t);
  assert.deepEqual(plain(view),test.view,'as-of allowlist '+test.t);
  assert.deepEqual(plain(context.OlistEngine.ruleMatches(view,config)),test.matches,'rules '+test.t);
  assert.deepEqual(plain(context.OlistEngine.alertsAt(test.row,test.t,config)),test.alerts,'alerts '+test.t);
  checks+=3;
}
const full=engine.query('/api/overview',{}),normal=engine.query('/api/overview',{start:'2017-01-01',end:'2018-06-30'});
assert.equal(full.cards.total_orders,99441);assert.equal(normal.cards.late_orders,5930);assert.equal(normal.cards.late_valid_orders,83696);
for(const [state,n,d] of [['RJ',1436,10891],['SP',1432,34523]]){const v=engine.query('/api/overview',{start:'2017-01-01',end:'2018-06-30',state});assert.equal(v.cards.late_orders,n);assert.equal(v.cards.late_valid_orders,d);}
const initial=engine.query('/api/alerts',{}),oid=initial.alerts[0].order_id;
const action={order_id:oid,status:'resolved',note:'test local state',updated_at:'2026-10-30T00:00:00.000Z',simulated:true};
const store={actions:{[oid]:action},history:[{...action,id:1}]};
const filtered=engine.query('/api/alerts',{action_status:'resolved'},store);
assert.equal(filtered.total,1);assert.equal(filtered.alerts[0].order_id,oid);
assert.equal(filtered.counts.resolved,1);assert.equal(filtered.counts.pending,initial.counts.pending-1);
const detail=engine.query('/api/order/'+oid,{mode:'replay',as_of:'2018-03-15T08:00'},store);
assert.equal(detail.action.status,'resolved');assert.equal(detail.action_history.length,1);
assert(!('order_status' in detail.order));assert(!('review_score' in detail.order));
console.log(JSON.stringify({passed:true,checks:checks+15,apiCases:expected.cases.length,asOfBoundaryCases:expected.boundaries.length,orders:orders.rows,items:items.rows},null,2));
