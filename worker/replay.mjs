/* Explicit as-of projection and historical alert construction. */
import {STATIC} from "./fields.mjs";
import {time,iso,scopeKeys,statuses,cmp,error,check,asOf,pagination} from "./helpers.mjs";
import {PRIORITY,TEXT,ruleMatches} from "./rules.mjs";

export function atTime(row,t) {
  const view={as_of:t,visible:false};
  if(!row.purchase_at || row.purchase_at>t)return view;
  Object.assign(view,{visible:true,order_id:row.order_id,purchase_at:row.purchase_at,stage:"purchased"});
  for(const [field,stage] of [["approved_at","approved"],["carrier_at","handed_to_carrier"],["delivered_at","delivered"]])if(row[field]&&row[field]<=t){view[field]=row[field];view.stage=stage;}
  if(view.approved_at){
    for(const field of STATIC)if(row[field]!=null)view[field]=row[field];
    if(row.shipping_limit_min)view.shipping_deadline_at=row.shipping_limit_min;
    if(row.estimated_at){view.estimated_at=row.estimated_at;view.promise_end_exclusive=iso(time(row.estimated_at.slice(0,10)+" 00:00:00")+86400000);}
  }
  return view;
}
export function alertsAt(row,t,c) {
  const v=atTime(row,t),matched=ruleMatches(v,c);if(!matched.length)return [];
  const primary=PRIORITY.find(code=>matched.includes(code)),[reason,level,suggestion]=TEXT[primary];
  return [{task_id:`${c.version}:${v.order_id}`,order_id:v.order_id,as_of:t,rule_version:c.version,primary_rule:primary,matched_rules:PRIORITY.filter(code=>matched.includes(code)),reason,level,suggestion,kind:t>=v.promise_end_exclusive?"overdue_monitoring":"before_promise_hint",shipping_deadline_at:v.shipping_deadline_at,promise_end_exclusive:v.promise_end_exclusive,hours_to_shipping_deadline:(time(v.shipping_deadline_at)-time(t))/3600000,hours_to_promise_end:(time(v.promise_end_exclusive)-time(t))/3600000}];
}

/* Queue construction keeps counts before rule/status filtering, then paginates. */
export function createReplayModule({scope,config,currentAction,replayNotes}) {
  function alerts(q,store) {
    check(q,[...scopeKeys,"as_of","page","limit","rule","action_status"]);const t=asOf(q.as_of??"2018-03-15T08:00",config),[page,limit]=pagination(q),{filters,selected}=scope(q),rule=q.rule??"all",status=q.action_status??"all";
    if(!["all","R1","R2","R3","R4"].includes(rule))error("invalid_rule","规则筛选可选all/R1/R2/R3/R4。");if(![...statuses,"all"].includes(status))error("invalid_status","处置筛选状态不合法。");
    const counts=Object.fromEntries([...PRIORITY,"before_promise_hint","overdue_monitoring",...statuses].map(k=>[k,0])),tasks=[];
    for(const row of selected){if(row.replay_eligible!==1||row.purchase_at>t||row.delivered_at&&row.delivered_at<=t)continue;
      const view=atTime(row,t);for(const task of alertsAt(row,t,config)){
        const action=currentAction(row.order_id,store);counts[task.primary_rule]++;counts[task.kind]++;counts[action.status]++;
        if(rule!=="all"&&!task.matched_rules.includes(rule)||status!=="all"&&action.status!==status)continue;tasks.push({...task,order:view,action});
      }
    }
    tasks.sort((a,b)=>PRIORITY.indexOf(a.primary_rule)-PRIORITY.indexOf(b.primary_rule)||cmp(a.promise_end_exclusive,b.promise_end_exclusive)||cmp(a.order_id,b.order_id));
    return {mode:"replay",as_of:t,filters,replay_scope:replayNotes[0],total:tasks.length,page,limit,pages:Math.ceil(tasks.length/limit),alerts:tasks.slice((page-1)*limit,page*limit),counts,counts_scope:"筛选商家/品类/州/下单日期后的全部当前任务，规则和处置状态筛选前计数。",notes:replayNotes};
  }
  return {alerts};
}
