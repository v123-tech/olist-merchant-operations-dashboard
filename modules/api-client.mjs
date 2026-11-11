import {createDataLoader} from './data-loader.mjs';
import {createStorageAdapter,STORAGE_KEY,STORAGE_LIMITS} from './storage.mjs';
import {dataError} from './schema.mjs';
import {createInitialOrdersSnapshot,isInitialOrdersQuery} from './initial-orders.mjs';
export function createApiClient(options={}){
  const base=options.baseUrl??new URL('../',import.meta.url),listeners=new Set(),pending=new Map();let worker,sequence=0,warmup,fullDataState='idle',autoWarmStarted=false,clientEpoch=0,invalidationCode='cache_cleared';
  const emit=progress=>{for(const fn of listeners)try{fn(progress);}catch{}};
  const loader=createDataLoader({baseUrl:base,fetchImpl:options.fetchImpl,cacheStorage:options.cacheStorage,onProgress:emit,timeoutMs:options.downloadTimeoutMs,maxRetries:options.maxRetries});
  const initial=createInitialOrdersSnapshot({loader});
  const hasForeground=()=>[...pending.values()].some(task=>task.foreground);
  const compactReady=()=>{if(!hasForeground()&&['idle','ready'].includes(fullDataState))emit({phase:'ready'});};
  const adapter=createStorageAdapter({storage:options.storage,locks:options.navigator===undefined?undefined:(options.navigator?.locks??null),now:options.now});
  const factory=options.workerFactory??((url,settings)=>new Worker(url,settings));
  function failSession(session,error,{notify=true}={}){
    // A late event from a terminated worker cannot reject a newer session.
    if(worker!==session)return;
    const onlyPreparation=pending.size>0&&[...pending.values()].every(task=>task.background);
    // A compact response is still usable after a Worker failure, but cannot
    // declare the full dataset ready. Explicit cache clearing resets to idle.
    worker=null;warmup=null;fullDataState=notify?'failed':'idle';
    session.onmessage=null;session.onerror=null;
    try{session.terminate();}catch{}
    for(const task of pending.values()){clearTimeout(task.timer);task.reject(error);}
    pending.clear();
    if(notify)emit({phase:onlyPreparation?'background_error':'error',message:error.message});
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
      if(event.data.type==='progress'){
        // A failed Promise.all load can leave other resource streams finishing.
        // Their late events must not replace the background failure with a spinner.
        if(fullDataState==='failed'&&!hasForeground())return;
        noteProgress(session,event.data.progress);if(event.data.progress?.phase==='ready')fullDataState='ready';emit(event.data.progress);return;
      }
      const task=pending.get(event.data.requestId);if(!task)return;
      pending.delete(event.data.requestId);clearTimeout(task.timer);
      if(event.data.error)task.reject(Object.assign(new Error(event.data.error.message),event.data.error));
      else {if(task.foreground)fullDataState='ready';task.resolve(event.data.data);}
    };
    session.onerror=()=>failSession(session,dataError('worker_error','数据处理未完成，请重新读取后重试。'));
    return session;
  }
  function rpc(path,query={},store){
    const session=ensureWorker();
    return new Promise((resolve,reject)=>{
      const requestId=++sequence;
      // Stop the failed session so a retry does not queue behind stalled work.
      const task={resolve,reject,background:path==='__prepare',foreground:path!=='__prepare'&&path!=='__metrics',progress:new Map(),deadline:Date.now()+(options.queryMaxDurationMs??35*60*1000)};
      if(task.foreground){const wasFailed=fullDataState==='failed';fullDataState='loading';if(wasFailed)emit({phase:'full_loading'});}
      pending.set(requestId,task);armTask(session,task);
      try{session.postMessage({requestId,path,query,store});}
      catch{failSession(session,dataError('worker_message','数据请求未能发送，请重新读取后重试。'));}
    });
  }
  function prepareFullData(){
    if(fullDataState==='ready'&&worker)return Promise.resolve({ready:true});
    if(warmup)return warmup;
    fullDataState='loading';emit({phase:'prepare'});
    let task;const token=clientEpoch;
    task=Promise.resolve().then(()=>{
      if(token!==clientEpoch)throw dataError(invalidationCode,'数据会话已重置，未启动旧的准备任务。');
      return rpc('__prepare');
    }).then(data=>{
      if(data?.ready!==true)throw dataError('prepare_invalid','完整历史数据尚未准备好。');
      if(warmup===task){fullDataState='ready';emit({phase:'ready'});}
      return {ready:true};
    }).catch(error=>{
      if(warmup===task){warmup=null;fullDataState='failed';if(!hasForeground())emit({phase:'background_error',code:error.code??'data_unavailable'});}
      return {ready:false,code:error.code??'data_unavailable'};
    });
    warmup=task;return task;
  }
  async function request(path,values={},settings={}){
    values=Object.fromEntries(Object.entries(values).filter(([,v])=>v!==''&&v!=null).map(([k,v])=>[k,String(v)]));
    if(path==='/api/action'){
      if(settings.method!=='POST'||Object.keys(values).length)throw dataError('invalid_request','处置接口需要POST且不接受地址参数。');
      return adapter.mutateAction(settings.body,{hasOrder:id=>initial.hasOrder(id)?Promise.resolve(true):rpc('__exists',{order_id:id})});
    }
    if(settings.method&&settings.method!=='GET')throw dataError('invalid_request','接口仅接受读取请求。');
    const resources={'/api/meta':'meta.json','/api/quality':'quality_report.json','/api/replay_report':'replay_results.json'};
    if(resources[path]){
      if(Object.keys(values).length)throw dataError('unknown_parameter','存在未支持参数。');
      const result=structuredClone(await loader.getJson(resources[path]));compactReady();return result;
    }
    if(path==='/api/overview'&&Object.keys(values).every(k=>['start','end','seller','category','state'].includes(k))&&values.start==='2017-01-01'&&values.end==='2018-06-30'&&!values.seller&&!values.category&&!values.state){
      const result=structuredClone(await loader.getJson('default-overview.json'));compactReady();return result;
    }
    if(path==='/api/orders'&&isInitialOrdersQuery(values)){
      try{
        const result=await initial.getPage();compactReady();
        if(!autoWarmStarted){autoWarmStarted=true;void prepareFullData();}
        return result;
      }catch(error){
        // Failed or untrusted snapshots never supply data. The original engine
        // independently reads and verifies its full historical resources.
        if(error.code==='cache_cleared'||error.code==='cache_reset')throw error;
        emit({phase:'snapshot_fallback'});
        return rpc(path,values);
      }
    }
    if(path.startsWith('/api/order/')&&Object.keys(values).length===1&&values.mode==='history'&&initial.hasOrder(path.slice(11))){
      const result=initial.detail(path.slice(11),values,adapter.read());
      if(result)return result;
    }
    return rpc(path,values,path==='/api/alerts'||path.startsWith('/api/order/')?adapter.read():undefined);
  }
  return {
    request,prepareFullData,
    resetActions:()=>adapter.reset(),storageKey:STORAGE_KEY,storageLimits:STORAGE_LIMITS,
    async clearDataCache(){
      clientEpoch++;invalidationCode='cache_cleared';initial.reset();warmup=null;fullDataState='idle';
      if(worker)failSession(worker,dataError('cache_cleared','数据缓存已清除，请重新读取。'),{notify:false});
      await loader.clearCache();
      return {cleared:true,persistentCacheAvailable:loader.getMetrics().cacheAvailable};
    },
    subscribeProgress(fn){listeners.add(fn);return()=>listeners.delete(fn);},
    async getMetrics(){return {page:loader.getMetrics(),worker:worker?await rpc('__metrics'):null};},
    dispose(){clientEpoch++;invalidationCode='client_disposed';initial.reset();warmup=null;fullDataState='idle';worker?.terminate();worker=null;for(const task of pending.values()){clearTimeout(task.timer);task.reject(dataError('client_disposed','数据会话已关闭。'));}pending.clear();listeners.clear();}
  };
}
export const api=createApiClient();
