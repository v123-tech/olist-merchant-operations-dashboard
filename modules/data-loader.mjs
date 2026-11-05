import {RESOURCE_NAMES,validateManifest,validatePayload,digest,dataError} from './schema.mjs';
import {DATA_RELEASE_ID} from './json-shapes.mjs';
const CACHE_NAME='shoppeek-verified-data-v2';
export function createDataLoader(options={}){
  const base=new URL(options.baseUrl??'../',import.meta.url),fetchImpl=options.fetchImpl??globalThis.fetch.bind(globalThis),cryptoImpl=options.cryptoImpl??globalThis.crypto;
  // A slow, progressing transfer is healthy. Bound inactivity separately from
  // the total attempt so a large file is not discarded after 30 seconds.
  const timeoutMs=options.timeoutMs??30000,maxDurationMs=options.maxDurationMs??15*60*1000,maxRetries=options.maxRetries??1,parsed=new Map(),bytesMemory=new Map(),controllers=new Set(),writes=new Set();let manifestPromise,cachePromise,epoch=0;
  const counters={networkRequests:0,networkBytes:0,memoryHits:0,persistentHits:0,invalidCache:0,parses:0,decompressions:0,cacheAvailable:null,timings:{},release:DATA_RELEASE_ID};
  const emit=e=>{try{options.onProgress?.(e);}catch{}};
  const clock=()=>globalThis.performance?.now?.()??Date.now();
  async function cache(){if(!cachePromise)cachePromise=Promise.resolve().then(()=>{const store=options.cacheStorage===undefined?globalThis.caches:options.cacheStorage;return store?.open(CACHE_NAME);}).then(c=>{counters.cacheAvailable=!!c;return c??null;}).catch(()=>{counters.cacheAvailable=false;return null;});return cachePromise;}
  const urlFor=name=>new URL('data/'+name,base);
  const cacheKey=(name,hash)=>{const u=urlFor(name);u.searchParams.set('shoppeek_verified',hash);return u.href;};
  const current=token=>{if(token!==epoch)throw dataError('cache_reset','数据缓存已清理，请重新读取。');};
  async function putCache(c,key,bytes,token){current(token);const pending=c.put(key,new Response(bytes));writes.add(pending);try{await pending;}finally{writes.delete(pending);}}
  const owned=request=>{const u=new URL(request.url??String(request));return u.origin===base.origin&&u.pathname.startsWith(new URL('data/',base).pathname)&&u.searchParams.has('shoppeek_verified');};
  async function pruneCache(c,m,token){const keep=new Set([cacheKey('manifest.json',DATA_RELEASE_ID),...RESOURCE_NAMES.map(n=>cacheKey(n,m.files[n].sha256))]);for(const request of await c.keys()){current(token);if(owned(request)&&!keep.has(request.url??String(request)))await c.delete(request);}}
  async function networkBytes(name,total,limit=name==='manifest.json'?256*1024:total){const token=epoch,started=clock();let last;for(let attempt=0;attempt<=maxRetries;attempt++){
    current(token);
    if(attempt)emit({phase:'retry',resource:name,attempt,maxRetries,message:'连接中断，正在重新下载此文件'});
    const controller=new AbortController();controllers.add(controller);let idleTimer,reader;
    const touch=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(),timeoutMs);};
    const deadline=setTimeout(()=>controller.abort(),maxDurationMs);touch();let received=0;
    try{
      counters.networkRequests++;const response=await fetchImpl(urlFor(name),{cache:'no-cache',signal:controller.signal});
      if(!response.ok){const error=dataError('http_error',`数据资源读取失败（${response.status}），请稍后重试。`);error.httpStatus=response.status;throw error;}
      touch();let out;
      if(response.body?.getReader){const chunks=[];reader=response.body.getReader();for(;;){const {done,value}=await reader.read();current(token);if(done)break;if(!value.byteLength)continue;touch();received+=value.byteLength;
        if(received>limit)throw dataError('data_size','数据大小超出已核验资源的读取范围。');chunks.push(value);emit({phase:'download',resource:name,attempt,loaded:received,total:received<=(total??0)?total:undefined});}
        out=new Uint8Array(received);let offset=0;for(const part of chunks){out.set(part,offset);offset+=part.byteLength;}
      }else{out=new Uint8Array(await response.arrayBuffer());current(token);if(out.byteLength>limit)throw dataError('data_size','数据大小超出已核验资源的读取范围。');emit({phase:'download',resource:name,attempt,loaded:out.byteLength,total:out.byteLength===total?total:undefined});}
      counters.networkBytes+=out.byteLength;counters.timings[name]={...(counters.timings[name]??{}),downloadMs:clock()-started};return out;
    }catch(e){current(token);last=e.name==='AbortError'?dataError('data_timeout','数据连接长时间无响应或下载已超出时限，请重试。'):e.code?e:dataError('network_error','数据连接中断，请检查网络后重试。');
      const retryable=['data_timeout','network_error'].includes(last.code)||last.httpStatus>=500||last.httpStatus===429;
      if(attempt===maxRetries||!retryable)throw last;
    }finally{clearTimeout(idleTimer);clearTimeout(deadline);controllers.delete(controller);controller.abort();if(reader)void reader.cancel().catch(()=>{});}
  }throw last;}
  async function getManifest(){if(!manifestPromise){const token=epoch;manifestPromise=(async()=>{emit({phase:'manifest',message:'读取数据版本'});const c=await cache(),key=cacheKey('manifest.json',DATA_RELEASE_ID);let bytes;try{bytes=await networkBytes('manifest.json');}catch(error){current(token);const saved=await c?.match(key).catch(()=>null);if(!saved)throw error;bytes=new Uint8Array(await saved.arrayBuffer());counters.persistentHits++;}
      current(token);let manifest;try{manifest=JSON.parse(new TextDecoder().decode(bytes));}catch{throw dataError('manifest_invalid','数据清单无法读取，请刷新后重试。');}await validateManifest(manifest,cryptoImpl);current(token);if(c)try{await putCache(c,key,bytes,token);await pruneCache(c,manifest,token);}catch(e){current(token);counters.cacheAvailable=false;}return manifest;})().catch(e=>{if(token===epoch){manifestPromise=null;emit({phase:'error',code:e.code??'data_error',message:e.message});}throw e;});}return manifestPromise;}
  async function verify(name,bytes,entry){emit({phase:'verify',resource:name,message:'核对数据完整性'});const hash=await digest(bytes,cryptoImpl);if(bytes.length===entry.bytes&&hash===entry.sha256)return entry.encoding==='gzip'?'gzip':'identity';if(bytes.length===entry.uncompressed_bytes&&hash===entry.uncompressed_sha256)return 'identity';throw dataError('data_hash','数据完整性校验失败，请重新读取，尚未使用这份数据。');}
  async function resourceBytes(name,entry,token){current(token);if(bytesMemory.has(name)){counters.memoryHits++;return bytesMemory.get(name);}const c=await cache(),key=cacheKey(name,entry.sha256);if(c){try{const saved=await c.match(key);if(saved){const bytes=new Uint8Array(await saved.arrayBuffer());const encoding=await verify(name,bytes,entry);current(token);counters.persistentHits++;emit({phase:'verify',resource:name,fromCache:true,message:'已核对浏览器缓存'});const r={bytes,encoding};bytesMemory.set(name,r);return r;}}catch(e){current(token);counters.invalidCache++;try{await c.delete(key);}catch{}}}
    const bytes=await networkBytes(name,entry.bytes,Math.max(entry.bytes,entry.uncompressed_bytes)),encoding=await verify(name,bytes,entry);current(token);if(c)try{await putCache(c,key,bytes,token);}catch(e){current(token);counters.cacheAvailable=false;}const result={bytes,encoding};current(token);bytesMemory.set(name,result);return result;}
  async function getJson(name){if(!RESOURCE_NAMES.includes(name))throw dataError('unknown_resource','不允许读取此数据资源。');if(parsed.has(name)){counters.memoryHits++;return parsed.get(name);}const token=epoch,pending=(async()=>{const m=await getManifest(),entry=m.files[name],{bytes,encoding}=await resourceBytes(name,entry,token);let decoded=bytes;const t=clock();if(encoding==='gzip'){if(typeof DecompressionStream==='undefined')throw dataError('gzip_unsupported','此浏览器无法解压历史数据，请使用新版浏览器。');try{decoded=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());}catch{throw dataError('data_gzip','历史数据解压失败，请清除数据缓存后重新读取。');}counters.decompressions++;if(decoded.length!==entry.uncompressed_bytes||await digest(decoded,cryptoImpl)!==entry.uncompressed_sha256)throw dataError('data_hash','解压后的数据校验失败，请重新读取。');}emit({phase:'decode',resource:name,message:'准备可查询的数据'});let value;try{value=JSON.parse(new TextDecoder().decode(decoded));}catch{throw dataError('data_json','数据内容不完整，请重新读取。');}counters.parses++;validatePayload(name,value,entry);current(token);counters.timings[name]={...(counters.timings[name]??{}),decodeAndValidateMs:clock()-t};return value;})().catch(e=>{if(token===epoch){parsed.delete(name);bytesMemory.delete(name);emit({phase:'error',resource:name,code:e.code??'data_error',message:e.message});}throw e;});parsed.set(name,pending);return pending;}
  async function clearCache(){epoch++;for(const controller of controllers)controller.abort();parsed.clear();bytesMemory.clear();manifestPromise=null;await Promise.allSettled([...writes]);const c=await cache();if(c)for(const request of await c.keys())if(owned(request))await c.delete(request);}
  return {getManifest,getJson,release(name){parsed.delete(name);bytesMemory.delete(name);},getMetrics(){return structuredClone({...counters,parsedResources:parsed.size,retainedByteBuffers:[...bytesMemory.values()].reduce((n,r)=>n+r.bytes.byteLength,0)});},clearCache};
}
