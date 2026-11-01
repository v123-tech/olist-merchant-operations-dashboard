/* Adapter contract tests; browser acceptance remains a separate live check. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const code=await readFile(path.join(project,'dist/static-api.js'),'utf8');
const order_id='1'.repeat(32),key='olist-portfolio:actions:v1';
let checks=0;
function client(state=new Map(),{readDenied=false,writeDenied=false}={}){
  const fetches=[];
  class FakeWorker {
    postMessage({requestId,path:route,query,store}){queueMicrotask(()=>this.onmessage({data:{requestId,data:route==='__exists'?query.order_id===order_id:route==='/api/alerts'?{query,store}:store}}));}
    terminate(){}
  }
  const storage={getItem:k=>{if(readDenied)throw Error('denied');return state.get(k)??null;},setItem:(k,v)=>{if(writeDenied)throw Error('quota');state.set(k,v);},removeItem:k=>state.delete(k)};
  const context=vm.createContext({document:{currentScript:{src:'https://demo.invalid/static-api.js'}},URL,Worker:FakeWorker,localStorage:storage,navigator:{},setTimeout,clearTimeout,structuredClone,fetch:async url=>{fetches.push(String(url));return {ok:true,json:async()=>({name:String(url)})};}});
  vm.runInContext(code,context);
  return {api:context.OlistAPI,state,fetches};
}
const a=client();
const post=(c,status,note='',id=order_id)=>c.api.request('/api/action',{},{method:'POST',body:JSON.stringify({order_id:id,status,note})});
await assert.rejects(post(a,'ignored','  '),e=>e.code==='reason_required');checks++;
await assert.rejects(post(a,'resolved','x','2'.repeat(32)),e=>e.code==='order_not_found');checks++;
await assert.rejects(post(a,'bad'),e=>e.code==='invalid_status');checks++;
await assert.rejects(post(a,'processing','x'.repeat(2001)),e=>e.code==='invalid_note');checks++;
let r=await post(a,'processing','<script>literal note</script>');assert.equal(r.changed,true);assert.equal(r.history_count,1);checks++;
r=await post(a,'processing','<script>literal note</script>');assert.equal(r.changed,false);assert.equal(r.history_count,1);checks++;
r=await post(a,'resolved','done');assert.equal(r.history_count,2);checks++;
const refreshed=client(a.state);r=await refreshed.api.request('/api/order/'+order_id);assert.equal(r.actions[order_id].status,'resolved');assert.equal(r.history.length,2);checks++;
const b=client();r=await b.api.request('/api/order/'+order_id);assert.equal(Object.keys(r.actions).length,0);checks++;
const query=await a.api.request('/api/alerts',{action_status:'',seller:'',limit:25});assert.deepEqual(JSON.parse(JSON.stringify(query.query)),{limit:'25'});checks++;
assert.equal(a.fetches.length,0);checks++;
await a.api.resetActions();assert.equal(a.state.has(key),false);checks++;
await post(a,'pending');checks++;
const broken=client(new Map([[key,'{broken']]));await assert.rejects(broken.api.request('/api/order/'+order_id),e=>e.code==='storage_invalid');await broken.api.resetActions();await post(broken,'resolved');checks++;
const denied=client(new Map(),{readDenied:true});await assert.rejects(denied.api.request('/api/order/'+order_id),e=>e.code==='storage_unavailable');checks++;
const full=client(new Map(),{writeDenied:true});await assert.rejects(post(full,'resolved'),e=>e.code==='storage_unavailable');assert.equal(full.state.size,0);checks++;
// The quota is a visible failure, never a silent truncation of action history.
const capped=client();for(let n=0;n<1000;n++)await post(capped,n%2?'processing':'resolved','n='+n);
await assert.rejects(post(capped,'ignored','over cap'),e=>e.code==='storage_limit');assert.equal(JSON.parse(capped.state.get(key)).history.length,1000);checks++;
assert.equal(a.fetches.length+b.fetches.length+capped.fetches.length,0);checks++;
console.log(JSON.stringify({passed:true,checks,scope:'localStorage adapter contract; no real-browser claim'},null,2));
