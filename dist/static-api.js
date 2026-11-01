/* Same-origin static resources and browser-local simulated actions. No action
 * or note is sent to a service, and no original historical record is written. */
"use strict";
(function(root){
  const base=new URL(".",document.currentScript.src), key="olist-portfolio:actions:v1";
  const limits={actions:500,history:1000,characters:900000};
  const allowed=["pending","processing","resolved","ignored"],pending=new Map(),cache=new Map();
  let worker,sequence=0;
  const fail=(message,code="invalid_request")=>{const e=new Error(message);e.code=code;throw e;};
  function empty(){return {version:1,nextId:1,actions:{},history:[]};}
  function validateId(id){if(typeof id!=="string"||!/^[0-9a-f]{32}$/.test(id))fail("订单ID必须为32位小写十六进制字符。","invalid_order_id");}
  function readStore(){
    let text;
    try{text=root.localStorage.getItem(key);}catch{fail("浏览器禁止本地保存。请允许此网站使用本地存储后重试；本次处置未保存。","storage_unavailable");}
    if(text===null)return empty();
    try{
      if(text.length>limits.characters)throw new Error();
      const s=JSON.parse(text);
      if(s.version!==1||!Number.isSafeInteger(s.nextId)||s.nextId<1||!s.actions||typeof s.actions!=="object"||Array.isArray(s.actions)||!Array.isArray(s.history)||Object.keys(s.actions).length>limits.actions||s.history.length>limits.history)throw new Error();
      const valid=a=>a&&/^[0-9a-f]{32}$/.test(a.order_id)&&allowed.includes(a.status)&&typeof a.note==="string"&&[...a.note].length<=2000&&typeof a.updated_at==="string"&&Number.isFinite(Date.parse(a.updated_at))&&a.simulated===true;
      if(!Object.entries(s.actions).every(([id,a])=>id===a.order_id&&valid(a))||!s.history.every(a=>valid(a)&&Number.isSafeInteger(a.id)&&a.id>0&&a.id<s.nextId))throw new Error();
      return s;
    }catch{fail("本浏览器的模拟记录损坏或超出限制。请使用“重置模拟记录”清除后重试；历史数据不受影响。","storage_invalid");}
  }
  function saveStore(s){
    const text=JSON.stringify(s);
    if(Object.keys(s.actions).length>limits.actions||s.history.length>limits.history||text.length>limits.characters)fail("本次演示记录已达到浏览器存储上限。请重置模拟记录后再试；本次处置未保存。","storage_limit");
    try{root.localStorage.setItem(key,text);}catch{fail("浏览器存储空间不足或禁止保存；本次处置未保存。请检查浏览器设置或重置模拟记录后重试。","storage_unavailable");}
  }
  function rpc(path,query={},store){
    if(!worker){
      worker=new Worker(new URL("data-worker.js",base));
      worker.onmessage=event=>{const item=pending.get(event.data.requestId);if(!item)return;pending.delete(event.data.requestId);clearTimeout(item.timer);if(event.data.error){const e=new Error(event.data.error.message);Object.assign(e,event.data.error);item.reject(e);}else item.resolve(event.data.data);};
      worker.onerror=()=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error("数据处理未完成。请刷新页面后重试。"));}pending.clear();worker.terminate();worker=null;};
    }
    return new Promise((resolve,reject)=>{const requestId=++sequence;const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error("数据读取超时。请检查网络后重试。"));},90000);pending.set(requestId,{resolve,reject,timer});worker.postMessage({requestId,path,query,store});});
  }
  async function resource(name){
    if(!cache.has(name))cache.set(name,fetch(new URL("data/"+name,base)).then(async r=>{if(!r.ok)throw new Error("数据资源暂不可读取，请检查网络后重试。");return r.json();}).catch(e=>{cache.delete(name);throw e;}));return structuredClone(await cache.get(name));
  }
  async function action(body){
    let b;try{b=typeof body==="string"?JSON.parse(body):body;}catch{fail("提交内容不是有效JSON。","invalid_json");}
    if(!b||typeof b!=="object"||Array.isArray(b)||Object.keys(b).some(k=>!["order_id","status","note"].includes(k)))fail("仅支持order_id、status、note字段。","invalid_body");
    validateId(b.order_id);
    if(!allowed.includes(b.status))fail("处置状态不合法。","invalid_status");
    const note=b.note??"";
    if(typeof note!=="string"||[...note].length>2000)fail("备注应为文本且不超过2000字符。","invalid_note");
    const trimmed=note.trim();if(b.status==="ignored"&&!trimmed)fail("忽略任务时必须填写原因。","reason_required");
    if(!await rpc("__exists",{order_id:b.order_id}))fail("订单不存在。","order_not_found");
    const commit=()=>{
      const store=readStore(),previous=store.actions[b.order_id],changed=!previous||previous.status!==b.status||previous.note!==trimmed;
      if(changed){const record={order_id:b.order_id,status:b.status,note:trimmed,updated_at:new Date().toISOString(),simulated:true};store.actions[b.order_id]=record;store.history.push({...record,id:store.nextId++});saveStore(store);}
      return {action:store.actions[b.order_id],changed,history_count:store.history.filter(r=>r.order_id===b.order_id).length,simulated:true,note:"仅保存本地演示处置，不改变历史履约事件，也不发送真实消息。"};
    };
    return root.navigator?.locks?root.navigator.locks.request(key,commit):commit();
  }
  const api={
    async request(path,values={},options={}){
      // Match app.js URL serialization: blank selects omit the parameter.
      values=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==""&&v!=null).map(([k,v])=>[k,String(v)]));
      if(path==="/api/action"){
        if(options.method!=="POST"||Object.keys(values).length)fail("处置接口需要POST且不接受地址参数。");return action(options.body);
      }
      if(options.method&&options.method!=="GET")fail("接口仅接受读取请求。");
      const resources={"/api/meta":"meta.json","/api/quality":"quality_report.json","/api/replay_report":"replay_results.json"};
      if(resources[path]){if(Object.keys(values).length)fail("存在未支持参数。","unknown_parameter");return resource(resources[path]);}
      // The default overview is generated by the original Python implementation.
      if(path==="/api/overview"&&Object.keys(values).every(k=>["start","end","seller","category","state"].includes(k))&&values.start==="2017-01-01"&&values.end==="2018-06-30"&&!values.seller&&!values.category&&!values.state)return resource("default-overview.json");
      return rpc(path,values,(path==="/api/alerts"||path.startsWith("/api/order/"))?readStore():undefined);
    },
    async resetActions(){const reset=()=>{try{root.localStorage.removeItem(key);}catch{fail("浏览器禁止清除本地存储，请检查设置后重试。","storage_unavailable");}return {reset:true,simulated:true};};return root.navigator?.locks?root.navigator.locks.request(key,reset):reset();},
    storageLimits:Object.freeze({...limits}),storageKey:key
  };
  root.OlistAPI=Object.freeze(api);
})(globalThis);
