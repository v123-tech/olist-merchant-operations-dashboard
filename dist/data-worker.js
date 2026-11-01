/* Browser-side equivalent of demo_server.py and replay.py. Historical values
 * are read-only; only explicit allowlisted fields enter an as-of snapshot. */
"use strict";
(function(root) {
  const ORDER_FIELDS = "order_id order_status purchase_at approved_at carrier_at delivered_at estimated_at promise_end_exclusive customer_state customer_city item_count seller_count item_amount_cents freight_amount_cents payment_amount_cents late_valid is_late review_valid review_score review_answer_at timeline_valid shipping_deadline_valid shipping_limit_min shipping_limit_max".split(" ");
  const LIST_FIELDS = "order_id purchase_at order_status customer_state item_count seller_count item_amount_cents freight_amount_cents matched_item_amount_cents matched_freight_amount_cents matched_item_rows late_valid is_late review_valid review_score estimated_at delivered_at".split(" ");
  const STATIC = "item_count seller_count single_item_seller_id single_product_id single_category customer_state item_amount_cents freight_amount_cents".split(" ");
  const PRIORITY = ["R4", "R2", "R3", "R1"];
  const TEXT = {R1:["交运截止临近","提示","核对备货与交接安排；必要时联系履约协作方。"],R2:["交运截止已过","紧急","核查是否已交运但记录未更新，并确认履约障碍。"],R3:["承诺收货日临近","关注","核查最新物流进展；评估是否需要人工跟进。"],R4:["承诺收货截止已过","逾期监控","核查物流与收货记录；登记异常跟进情况。"]};
  const scopeKeys = ["start","end","seller","category","state"];
  const statuses = ["pending","processing","resolved","ignored"];
  const ratio = (a,b) => b ? a / b : null;
  const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const pick = (object, fields) => Object.fromEntries(fields.map(key => [key, object[key] ?? null]));
  const error = (code,message,status=400) => {const e = new Error(message);e.code=code;e.status=status;throw e;};
  function check(query,allowed) { const extras=Object.keys(query).filter(k=>!allowed.includes(k));if(extras.length)error("unknown_parameter","存在未支持参数："+extras.sort().join(",")); }
  function id(value) { if(typeof value!=="string" || !/^[0-9a-f]{32}$/.test(value))error("invalid_order_id","订单ID必须为32位小写十六进制字符。");return value; }
  function date(value,field) { if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+"T00:00:00Z")) || new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value || value.startsWith("0000"))error("invalid_date",`${field}需要有效日期YYYY-MM-DD。`); return value; }
  function time(value) { return value == null ? null : Date.parse(String(value).replace(" ","T")+"Z"); }
  function iso(value) { return new Date(value).toISOString().slice(0,19).replace("T"," "); }
  function asOf(value,config) {
    if(typeof value!=="string" || !/^20(16|17|18)-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value))error("invalid_as_of","观察时点需要2016—2018年数据本地时间，如2018-08-15T08:00。");
    const normalized=value.replace("T"," ")+(value.length===16?":00":"");
    const t=time(normalized);
    if(!Number.isFinite(t) || iso(t)!==normalized)error("invalid_as_of","观察时点需要2016—2018年数据本地时间，如2018-08-15T08:00。");
    if(normalized>=config.outcome_cutoff_exclusive)error("as_of_outside_boundary","观察时点必须早于配置中的回放观测边界。");return normalized;
  }
  function pagination(q) { return ["page","limit"].map((key,i)=> { const value=String(q[key]??(i?25:1));if(!/^[0-9]+$/.test(value)||+value<1||+value>(i?200:1000000))error("invalid_pagination",`${key}超出有效范围。`);return +value; }); }
  function atTime(row,t) {
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
  function knownProblem(v) {
    if(v.item_count!==1)return true;
    if(!v.approved_at)return false;
    if(!v.shipping_deadline_at||!v.promise_end_exclusive)return true;
    if(v.approved_at<v.purchase_at||v.shipping_deadline_at<v.approved_at||v.promise_end_exclusive<=v.purchase_at||v.shipping_deadline_at>=v.promise_end_exclusive)return true;
    if(v.carrier_at&&v.carrier_at<v.approved_at)return true;
    return !!(v.delivered_at&&(!v.carrier_at||v.delivered_at<v.carrier_at));
  }
  function ruleMatches(v,c) {
    if(!v.visible||!v.approved_at||knownProblem(v))return [];
    const t=time(v.as_of), shipping=time(v.shipping_deadline_at), promise=time(v.promise_end_exclusive), out=[];
    if(!v.carrier_at&&!v.delivered_at){const remaining=shipping-t;if(remaining>=0&&remaining<=c.shipping_warning_hours*3600000)out.push("R1");if(t>shipping)out.push("R2");}
    if(!v.delivered_at){if(t>=promise-c.delivery_warning_hours*3600000&&t<promise)out.push("R3");if(t>=promise)out.push("R4");}return out;
  }
  function alertsAt(row,t,c) {
    const v=atTime(row,t),matched=ruleMatches(v,c);if(!matched.length)return [];
    const primary=PRIORITY.find(code=>matched.includes(code)),[reason,level,suggestion]=TEXT[primary];
    return [{task_id:`${c.version}:${v.order_id}`,order_id:v.order_id,as_of:t,rule_version:c.version,primary_rule:primary,matched_rules:PRIORITY.filter(code=>matched.includes(code)),reason,level,suggestion,kind:t>=v.promise_end_exclusive?"overdue_monitoring":"before_promise_hint",shipping_deadline_at:v.shipping_deadline_at,promise_end_exclusive:v.promise_end_exclusive,hours_to_shipping_deadline:(time(v.shipping_deadline_at)-time(t))/3600000,hours_to_promise_end:(time(v.promise_end_exclusive)-time(t))/3600000}];
  }
  function decode(payload) {return Array.from({length:payload.rows},(_,i)=>Object.fromEntries(payload.fields.map((key,j)=>[key,payload.columns[j][i]])));}
  function createEngine(orderPayload,itemPayload,meta,config) {
    const orders=decode(orderPayload), items=decode(itemPayload), byId=new Map(orders.map(row=>[row.order_id,row])), byOrder=new Map();
    for(const item of items){if(!byOrder.has(item.order_id))byOrder.set(item.order_id,[]);byOrder.get(item.order_id).push(item);}
    const notes=meta.disclaimer.slice(0,4), replayNotes=meta.disclaimer.slice(4);
    const defaultAction=order_id=>({order_id,status:"pending",note:"",updated_at:null,simulated:true});
    const currentAction=(order_id,store)=>store?.actions?.[order_id]||defaultAction(order_id);
    function scope(q) {
      const filters=Object.fromEntries(scopeKeys.map(k=>[k,q[k]||""]));
      if(filters.start)date(filters.start,"start");if(filters.end)date(filters.end,"end");
      if(filters.start&&filters.end&&filters.start>filters.end)error("invalid_date_range","开始日期不能晚于结束日期。");
      if(filters.end==="9999-12-31")error("invalid_date","结束日期超出可计算范围。");
      if(filters.seller)id(filters.seller);
      if(filters.category.length>120)error("invalid_category","品类名称过长。");
      if(filters.state&&!/^[A-Z]{2}$/.test(filters.state))error("invalid_state","州代码需要2位大写字母。");
      const selected=[];
      for(const row of orders){
        if(filters.start&&(!row.purchase_at||row.purchase_at.slice(0,10)<filters.start)||filters.end&&(!row.purchase_at||row.purchase_at.slice(0,10)>filters.end)||filters.state&&row.customer_state!==filters.state)continue;
        const matches=(byOrder.get(row.order_id)||[]).filter(item=>(!filters.seller||item.seller_id===filters.seller)&&(!filters.category||item.category===filters.category));
        if((filters.seller||filters.category)&&!matches.length)continue;
        const valid=matches.filter(i=>!i.invalid_money_row);
        selected.push({...row,matched_item_rows:matches.length,matched_item_amount_cents:valid.length?valid.reduce((s,i)=>s+i.price_cents,0):null,matched_freight_amount_cents:valid.length?valid.reduce((s,i)=>s+i.freight_cents,0):null,matched_invalid_money_rows:matches.reduce((s,i)=>s+i.invalid_money_row,0)});
      }
      return {filters,selected};
    }
    function overview(q) {
      check(q,scopeKeys);const {filters,selected}=scope(q);
      const r=Object.fromEntries("total_orders delivered_orders no_item_orders matching_item_orders matched_item_rows amount_valid_orders delivered_amount_valid_orders item_amount_cents freight_amount_cents delivered_item_amount_cents late_valid_orders late_orders review_valid_orders low_score_orders".split(" ").map(k=>[k,0])), months=new Map(),states=new Map();
      for(const row of selected){
        r.total_orders++;const delivered=row.order_status==="delivered",amountValid=row.matched_item_rows>0&&row.matched_invalid_money_rows===0,late=row.late_valid===1&&row.is_late===1;
        r.delivered_orders+=+delivered;r.no_item_orders+=+(row.item_count===0);r.matching_item_orders+=+(row.matched_item_rows>0);r.matched_item_rows+=row.matched_item_rows;r.amount_valid_orders+=+amountValid;r.delivered_amount_valid_orders+=+(delivered&&amountValid);r.item_amount_cents+=row.matched_item_amount_cents||0;r.freight_amount_cents+=row.matched_freight_amount_cents||0;r.delivered_item_amount_cents+=delivered?(row.matched_item_amount_cents||0):0;r.late_valid_orders+=row.late_valid||0;r.late_orders+=+late;r.review_valid_orders+=row.review_valid||0;r.low_score_orders+=+(row.review_valid===1&&row.review_score<=2);
        for(const [map,key,keyName] of [[months,row.purchase_month,"month"],[states,row.customer_state,"state"]]){
          if(!map.has(key))map.set(key,{[keyName]:key,orders:0,late_valid_orders:0,late_orders:0,...(keyName==="month"?{item_amount_brl:0}:{})});const group=map.get(key);group.orders++;group.late_valid_orders+=row.late_valid||0;group.late_orders+=+late;if(keyName==="month")group.item_amount_brl+=row.matched_item_amount_cents||0;
        }
      }
      const cards=pick(r,"total_orders delivered_orders item_amount_cents freight_amount_cents delivered_item_amount_cents delivered_amount_valid_orders late_valid_orders late_orders review_valid_orders low_score_orders".split(" "));
      Object.assign(cards,{item_amount_brl:r.item_amount_cents/100,delivered_item_amount_brl:r.delivered_item_amount_cents/100,delivered_avg_item_amount_brl:ratio(r.delivered_item_amount_cents/100,r.delivered_amount_valid_orders),freight_amount_brl:r.freight_amount_cents/100,avg_item_amount_brl:ratio(r.item_amount_cents/100,r.amount_valid_orders),late_rate:ratio(r.late_orders,r.late_valid_orders),low_score_rate:ratio(r.low_score_orders,r.review_valid_orders)});
      const coverage=pick(r,"no_item_orders matching_item_orders matched_item_rows amount_valid_orders late_valid_orders review_valid_orders".split(" "));Object.assign(coverage,{amount_coverage:ratio(r.amount_valid_orders,r.total_orders),late_coverage:ratio(r.late_valid_orders,r.total_orders),review_coverage:ratio(r.review_valid_orders,r.total_orders)});
      const monthly=[...months.values()].sort((a,b)=>cmp(a.month,b.month)), regional=[...states.values()].sort((a,b)=>b.orders-a.orders||cmp(a.state,b.state));
      for(const g of monthly)g.item_amount_brl/=100;for(const g of [...monthly,...regional])g.late_rate=ratio(g.late_orders,g.late_valid_orders);
      return {filters,cards,coverage,monthly,states:regional,notes};
    }
    function list(q) {
      check(q,[...scopeKeys,"page","limit","late"]);const {filters,selected}=scope(q),[page,limit]=pagination(q),late=q.late??"all";
      if(!["all","late","on_time","unknown"].includes(late))error("invalid_late","晚到筛选可选all/late/on_time/unknown。");
      const rows=selected.filter(r=>late==="all"||late==="late"&&r.late_valid===1&&r.is_late===1||late==="on_time"&&r.late_valid===1&&r.is_late===0||late==="unknown"&&r.late_valid===0).sort((a,b)=>cmp(b.purchase_at,a.purchase_at)||cmp(a.order_id,b.order_id));
      return {filters,total:rows.length,page,limit,pages:Math.ceil(rows.length/limit),orders:rows.slice((page-1)*limit,page*limit).map(r=>({...pick(r,LIST_FIELDS),review_score:r.review_valid?r.review_score:null})),notes};
    }
    function detail(order_id,q,store) {
      id(order_id);check(q,["mode","as_of"]);const mode=q.mode||(q.as_of?"replay":"history");
      if(!["history","replay"].includes(mode)||mode==="history"&&q.as_of)error("invalid_mode","历史详情不接受as_of；回放详情需要观察时点。");
      const t="as_of" in q?asOf(q.as_of,config):null;
      if(mode==="replay"&&!t)error("as_of_required","回放详情必须提供as_of。");
      const row=byId.get(order_id);if(!row)error("order_not_found","订单不存在。",404);
      if(mode==="replay"&&row.replay_eligible!==1)error("outside_replay_scope","该订单不属于首版回放样本，请使用历史详情。",422);
      const view=mode==="replay"?atTime(row,t):pick(row,ORDER_FIELDS);
      if(mode==="replay"&&!view.visible)error("order_not_visible","观察时点尚未发生该订单。",404);
      if(mode==="history"&&!view.review_valid)view.review_score=null;
      const itemFields="order_item_id product_id seller_id category price_cents freight_cents shipping_limit_at".split(" ");
      const result={mode,order:view,items:mode==="history"||view.approved_at?(byOrder.get(order_id)||[]).map(r=>pick(r,itemFields)):[],timeline:[["purchase_at","下单"],["approved_at","支付批准"],["carrier_at","交承运商"],["delivered_at","实际收货"]].filter(([key])=>view[key]).map(([key,label])=>({key,label,at:view[key]})),action:currentAction(order_id,store),action_history:(store?.history||[]).filter(r=>r.order_id===order_id).sort((a,b)=>b.id-a.id),notes:mode==="replay"?replayNotes:notes,simulated_actions:true};
      if(mode==="replay")Object.assign(result,{as_of:t,alerts:alertsAt(row,t,config),replay_scope:replayNotes[0]});return result;
    }
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
    return {query(path,q={},store={}){if(path==="/api/overview")return overview(q);if(path==="/api/orders")return list(q);if(path==="/api/alerts")return alerts(q,store);if(path.startsWith("/api/order/"))return detail(path.slice(11),q,store);error("not_found","接口不存在。",404);},hasOrder:order_id=>byId.has(order_id)};
  }
  root.OlistEngine={createEngine,atTime,ruleMatches,alertsAt,decode};
  // Node regression tests evaluate this same file without registering a worker.
  if(typeof WorkerGlobalScope!=="undefined"&&root instanceof WorkerGlobalScope){
    let ready;
    async function json(name) {const response=await fetch(new URL("data/"+name,root.location));if(!response.ok)throw new Error("数据资源读取失败，请检查网络后重试。");if(name.endsWith(".gz")){if(typeof DecompressionStream==="undefined")throw new Error("请使用新版 Chrome、Edge、Firefox 或 Safari 访问完整数据演示。");return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();}return response.json();}
    async function engine() {if(!ready)ready=Promise.all([json("orders.json.gz"),json("items.json.gz"),json("meta.json"),json("config.json")]).then(args=>createEngine(...args)).catch(e=>{ready=null;throw e;});return ready;}
    root.onmessage=async event=>{const {requestId,path,query,store}=event.data;try{const e=await engine();const data=path==="__exists"?e.hasOrder(query.order_id):e.query(path,query,store);root.postMessage({requestId,data});}catch(e){root.postMessage({requestId,error:{message:e.message,code:e.code||"data_unavailable",status:e.status||503}});}};
  }
})(globalThis);
