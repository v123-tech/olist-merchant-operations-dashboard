/* Pure calculation composition: decode, index construction and API dispatch.
 * Data loading, schema checks and Worker RPC live outside this module. */
import {error} from "./helpers.mjs";
import {createQueryModule} from "./query.mjs";
import {createReplayModule} from "./replay.mjs";
export {atTime,alertsAt} from "./replay.mjs";
export {ruleMatches} from "./rules.mjs";

export function decode(payload) {return Array.from({length:payload.rows},(_,i)=>Object.fromEntries(payload.fields.map((key,j)=>[key,payload.columns[j][i]])));}
export function createEngine(orderPayload,itemPayload,meta,config) {
  const orders=decode(orderPayload), items=decode(itemPayload), byId=new Map(orders.map(row=>[row.order_id,row])), byOrder=new Map();
  for(const item of items){if(!byOrder.has(item.order_id))byOrder.set(item.order_id,[]);byOrder.get(item.order_id).push(item);}
  const notes=meta.disclaimer.slice(0,4), replayNotes=meta.disclaimer.slice(4);
  const defaultAction=order_id=>({order_id,status:"pending",note:"",updated_at:null,simulated:true});
  const currentAction=(order_id,store)=>store?.actions?.[order_id]||defaultAction(order_id);
  const {scope,overview,list,detail}=createQueryModule({orders,byId,byOrder,notes,replayNotes,config,currentAction});
  const {alerts}=createReplayModule({scope,config,currentAction,replayNotes});
  return {query(path,q={},store={}){if(path==="/api/overview")return overview(q);if(path==="/api/orders")return list(q);if(path==="/api/alerts")return alerts(q,store);if(path.startsWith("/api/order/"))return detail(path.slice(11),q,store);error("not_found","接口不存在。",404);},hasOrder:order_id=>byId.has(order_id)};
}
