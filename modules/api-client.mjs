import {createDataLoader} from './data-loader.mjs';
import {createStorageAdapter,STORAGE_KEY,STORAGE_LIMITS} from './storage.mjs';
import {dataError} from './schema.mjs';
export function createApiClient(options={}){
  const base=options.baseUrl??new URL('../',import.meta.url),listeners=new Set(),pending=new Map();let worker,sequence=0;
  const emit=progress=>{for(const fn of listeners)try{fn(progress);}catch{}};
  const loader=createDataLoader({baseUrl:base,fetchImpl:options.fetchImpl,cacheStorage:options.cacheStorage,onProgress:emit,timeoutMs:options.downloadTimeoutMs,maxRetries:options.maxRetries});
  const adapter=createStorageAdapter({storage:options.storage,locks:options.navigator===undefined?undefined:(options.navigator?.locks??null),now:options.now});
  const factory=options.workerFactory??((url,settings)=>new Worker(url,settings));
  function failSession(session,error,{notify=true}={}){
    // A late event from a terminated worker cannot reject a newer session.
    if(worker!==session)return;
    worker=null;
    session.onmessage=null;session.onerror=null;
    try{session.terminate();}catch{}
    for(const task of pending.values()){clearTimeout(task.timer);task.reject(error);}
    pending.clear();
    if(notify)emit({phase:'error',message:error.message});
  }
  function armTask(session,task){
    clearTimeout(task.timer);
    const remaining=task.deadline-Date.now();
    task.timer=setTimeout(()=>failSession(session,dataError('query_timeout','数据处理长时间无响应，请重试。')),Math.max(0,Math.min(options.queryTimeoutMs??90000,remaining)));
  }
  function noteProgress(session,event={}){
    // Only new work extends the inactivity watchdog; duplicate byte reports
    // cannot keep a stalled session alive, and the hard deadline still applies.
    let key,value;
    if(event.phase==='download'&&Number.isFinite(event.loaded)&&event.loaded>0){key=`download:${event.resource}:${event.attempt??0}`;value=event.loaded;}
    else if(['manifest','verify','decode','ready','retry'].includes(event.phase)){key=`${event.phase}:${event.resource??''}:${event.attempt??0}`;value=1;}
    else return;
    for(const task of pending.values())if(value>(task.progress.get(key)??0)){task.progress.set(key,value);armTask(session,task);}
  }
  function ensureWorker(){
    if(worker)return worker;
    let session;
    try{session=factory(new URL('worker/entry.mjs',base),{type:'module'});}
    catch{throw dataError('worker_unavailable','浏览器未能启动数据处理，请重新读取后重试。');}
    worker=session;
    session.onmessage=event=>{
      if(worker!==session)return;
      if(event.data.type==='progress'){noteProgress(session,event.data.progress);emit(event.data.progress);return;}
      const task=pending.get(event.data.requestId);if(!task)return;
      pending.delete(event.data.requestId);clearTimeout(task.timer);
      if(event.data.error)task.reject(Object.assign(new Error(event.data.error.message),event.data.error));
      else task.resolve(event.data.data);
    };
    session.onerror=()=>failSession(session,dataError('worker_error','数据处理未完成，请重新读取后重试。'));
    return session;
  }
  function rpc(path,query={},store){
    const session=ensureWorker();
    return new Promise((resolve,reject)=>{
      const requestId=++sequence;
      // Stop the failed session so a retry does not queue behind stalled work.
      const task={resolve,reject,progress:new Map(),deadline:Date.now()+(options.queryMaxDurationMs??35*60*1000)};
      pending.set(requestId,task);armTask(session,task);
      try{session.postMessage({requestId,path,query,store});}
      catch{failSession(session,dataError('worker_message','数据请求未能发送，请重新读取后重试。'));}
    });
  }
  return {
    async request(path,values={},settings={}){values=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==''&&v!=null).map(([k,v])=>[k,String(v)]));if(path==='/api/action'){if(settings.method!=='POST'||Object.keys(values).length)throw dataError('invalid_request','处置接口需要POST且不接受地址参数。');return adapter.mutateAction(settings.body,{hasOrder:id=>rpc('__exists',{order_id:id})});}if(settings.method&&settings.method!=='GET')throw dataError('invalid_request','接口仅接受读取请求。');const resources={'/api/meta':'meta.json','/api/quality':'quality_report.json','/api/replay_report':'replay_results.json'};if(resources[path]){if(Object.keys(values).length)throw dataError('unknown_parameter','存在未支持参数。');const result=structuredClone(await loader.getJson(resources[path]));emit({phase:'ready'});return result;}if(path==='/api/overview'&&Object.keys(values).every(k=>['start','end','seller','category','state'].includes(k))&&values.start==='2017-01-01'&&values.end==='2018-06-30'&&!values.seller&&!values.category&&!values.state){const result=structuredClone(await loader.getJson('default-overview.json'));emit({phase:'ready'});return result;}return rpc(path,values,path==='/api/alerts'||path.startsWith('/api/order/')?adapter.read():undefined);},
    resetActions:()=>adapter.reset(),storageKey:STORAGE_KEY,storageLimits:STORAGE_LIMITS,
    async clearDataCache(){
      if(worker)failSession(worker,dataError('cache_cleared','数据缓存已清除，请重新读取。'),{notify:false});
      await loader.clearCache();
      return {cleared:true,persistentCacheAvailable:loader.getMetrics().cacheAvailable};
    },
    subscribeProgress(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async getMetrics(){return {page:loader.getMetrics(),worker:worker?await rpc('__metrics'):null};},
    dispose(){worker?.terminate();worker=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(dataError('client_disposed','数据会话已关闭。'));}pending.clear();listeners.clear();}
  };
}
export const api=createApiClient();
