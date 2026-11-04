/* Frozen R1–R4 predicates and one-task priority; no data loading or storage. */
import {time} from "./helpers.mjs";

export const PRIORITY = ["R4", "R2", "R3", "R1"];
export const TEXT = {R1:["交运截止临近","提示","核对备货与交接安排；必要时联系履约协作方。"],R2:["交运截止已过","紧急","核查是否已交运但记录未更新，并确认履约障碍。"],R3:["承诺收货日临近","关注","核查最新物流进展；评估是否需要人工跟进。"],R4:["承诺收货截止已过","逾期监控","核查物流与收货记录；登记异常跟进情况。"]};
export function knownProblem(v) {
  if(v.item_count!==1)return true;
  if(!v.approved_at)return false;
  if(!v.shipping_deadline_at||!v.promise_end_exclusive)return true;
  if(v.approved_at<v.purchase_at||v.shipping_deadline_at<v.approved_at||v.promise_end_exclusive<=v.purchase_at||v.shipping_deadline_at>=v.promise_end_exclusive)return true;
  if(v.carrier_at&&v.carrier_at<v.approved_at)return true;
  return !!(v.delivered_at&&(!v.carrier_at||v.delivered_at<v.carrier_at));
}
export function ruleMatches(v,c) {
  if(!v.visible||!v.approved_at||knownProblem(v))return [];
  const t=time(v.as_of), shipping=time(v.shipping_deadline_at), promise=time(v.promise_end_exclusive), out=[];
  if(!v.carrier_at&&!v.delivered_at){const remaining=shipping-t;if(remaining>=0&&remaining<=c.shipping_warning_hours*3600000)out.push("R1");if(t>shipping)out.push("R2");}
  if(!v.delivered_at){if(t>=promise-c.delivery_warning_hours*3600000&&t<promise)out.push("R3");if(t>=promise)out.push("R4");}return out;
}
