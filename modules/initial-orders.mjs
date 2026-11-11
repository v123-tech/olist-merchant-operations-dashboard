/* Exact, hash-verified query materialization. Full query semantics stay in the Worker. */
import {dataError,validatePayload} from './schema.mjs';
const DEFAULT_QUERY=Object.freeze({start:'2017-01-01',end:'2018-06-30',page:'1',limit:'10',late:'all'});
const SOURCES=['orders.json.gz','items.json.gz','meta.json','config.json'];
const keysEqual=(object,keys)=>object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).length===keys.length&&keys.every(key=>Object.hasOwn(object,key));
export function isInitialOrdersQuery(query){
  return !!(keysEqual(query,Object.keys(DEFAULT_QUERY))&&Object.entries(DEFAULT_QUERY).every(([key,value])=>query[key]===value));
}
function validateSnapshot(value,manifest){
  validatePayload('default-orders.json',value,manifest.files['default-orders.json']);
  const reject=()=>{throw dataError('initial_orders_schema','最近订单数据未通过校验，正在读取完整历史数据。');};
  if(value.snapshot_version!==1||!isInitialOrdersQuery(value.query)||!keysEqual(value.source_hashes,SOURCES)||SOURCES.some(name=>value.source_hashes[name]!==manifest.files[name]?.sha256))reject();
  const {page,details}=value;
  if(page.page!==1||page.limit!==10||page.total!==86288||page.pages!==8629||page.orders.length!==10||details.length!==10)reject();
  const filters={start:DEFAULT_QUERY.start,end:DEFAULT_QUERY.end,seller:'',category:'',state:''};
  if(!keysEqual(page.filters,Object.keys(filters))||Object.entries(filters).some(([key,v])=>page.filters[key]!==v))reject();
  const ids=page.orders.map(row=>row.order_id);
  if(new Set(ids).size!==10||ids.some(id=>!/^[a-f0-9]{32}$/.test(id)))reject();
  for(let index=0;index<details.length;index++){
    const detail=details[index];
    if(detail.mode!=='history'||detail.order.order_id!==ids[index]||Object.hasOwn(detail,'action')||Object.hasOwn(detail,'action_history')||Object.hasOwn(detail,'as_of')||Object.hasOwn(detail,'alerts'))reject();
  }
  return value;
}
export function createInitialOrdersSnapshot({loader}){
  let value,pending,epoch=0;
  async function getPage(){
    if(!pending){const token=epoch;pending=(async()=>{
      const manifest=await loader.getManifest(),snapshot=await loader.getJson('default-orders.json');
      const checked=validateSnapshot(snapshot,manifest);
      if(token!==epoch)throw dataError('cache_cleared','数据缓存已清除，请重新读取。');
      value=structuredClone(checked);
      return value;
    })().catch(error=>{if(token===epoch){value=null;pending=null;}throw error;});}
    return structuredClone((await pending).page);
  }
  function hasOrder(id){return !!value?.details.some(detail=>detail.order.order_id===id);}
  function detail(id,query,store){
    if(!hasOrder(id)||!keysEqual(query,['mode'])||query.mode!=='history')return null;
    const result=structuredClone(value.details.find(detail=>detail.order.order_id===id));
    result.action=structuredClone(store?.actions?.[id]??{order_id:id,status:'pending',note:'',updated_at:null,simulated:true});
    result.action_history=structuredClone((store?.history??[]).filter(record=>record.order_id===id).sort((a,b)=>b.id-a.id));
    return result;
  }
  return {getPage,hasOrder,detail,reset(){epoch++;value=null;pending=null;}};
}
