/* Historical scope, aggregates, ordered lists and detail response projection.
 * Receives decoded read-only rows and indexes; performs no I/O. */
import {ORDER_FIELDS,LIST_FIELDS} from "./fields.mjs";
import {scopeKeys,ratio,cmp,pick,error,check,id,date,asOf,pagination} from "./helpers.mjs";
import {atTime,alertsAt} from "./replay.mjs";

export function createQueryModule({orders,byId,byOrder,notes,replayNotes,config,currentAction}) {
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
  return {scope,overview,list,detail};
}
