/** order-detail: preserved V1 templates and request sequence guards, with injected services. */
export function createOrderDetail(ctx) {
  const {$,$$,app,request,esc,num,money,dateTime,localSavedTime,categoryLabel,badge,lateBadge,actionBadge,ruleClass,hoursText,labels,loading,empty,errorHTML,toast,formError}=ctx;
  const hideChartTooltip=(...args)=>ctx.hideChartTooltip(...args);
  const loadReplay=(...args)=>ctx.loadReplay(...args);
function ruleDetails(task) {
  if (!task) return "";
  return (task.matched_rules || [task.primary_rule]).map(code=> {
    const shipping=["R1","R2"].includes(code), remaining=shipping?task.hours_to_shipping_deadline:task.hours_to_promise_end;
    const sentence=shipping?"尚未看到交承运商事件":"尚未看到收货事件";
    return `<div class="detail-rule ${ruleClass(code)}"><strong>${esc(code)} · ${esc(labels.rule[code])}</strong><p>${esc(sentence)}；${esc(hoursText(remaining,shipping?"交运截止":"承诺截止"))}。<br>截止 ${esc(dateTime(shipping?task.shipping_deadline_at:task.promise_end_exclusive))}${shipping?"":"（次日00:00，不含）"}</p></div>`;
  }).join("") + `<div class="suggested-action"><strong>建议检查</strong><p>${esc(task.suggestion)}</p></div><p class="drawer-note">${esc(task.rule_version)} · 一单一个任务，保留全部触发原因。建议动作尚需真实目标用户验证。</p>`;
}

function timelineHTML(data) {
  const events=data.timeline || [];
  if (!events.length) return empty("尚无可见事件","这一历史时点没有可展示的事件记录。");
  return `<ol class="timeline">${events.map(event=>`<li><strong>${esc(event.label)}</strong><time>${esc(dateTime(event.at))}</time></li>`).join("")}</ol>`;
}

function historicalQualityHTML(row) {
  // Retrospective flags belong to historical detail only, never to the replay UI.
  const fields = [["purchase_at","下单时间"],["approved_at","批准时间"],["carrier_at","交承运商时间"],["delivered_at","实际收货时间"],["estimated_at","预计收货日期"]];
  const missing = fields.filter(([key]) => !row[key]).map(([,label]) => label);
  const before = (left,right) => row[left] && row[right] && String(row[left]).replace("T"," ") < String(row[right]).replace("T"," ");
  const reversed = [];
  if (before("approved_at","purchase_at")) reversed.push("批准早于下单");
  if (before("carrier_at","approved_at")) reversed.push("交承运商早于批准");
  if (before("delivered_at","carrier_at")) reversed.push("收货早于交承运商");
  const issues = [];
  if (Number(row.timeline_valid) === 0 && row.timeline_valid != null) {
    if (missing.length) issues.push(`关键时间缺失：${missing.join("、")}。`);
    if (reversed.length) issues.push(`事件时间倒置：${reversed.join("、")}。`);
    if (!missing.length && !reversed.length) issues.push("关键时间或事件顺序未通过校验，需核查原始记录。");
  }
  if (Number(row.shipping_deadline_valid) === 0 && row.shipping_deadline_valid != null) {
    const deadlineIssues = [];
    if (!row.shipping_limit_min || !row.shipping_limit_max) deadlineIssues.push("交运截止缺失");
    if (!row.approved_at) deadlineIssues.push("批准时间缺失，无法核对交运截止");
    if (!row.promise_end_exclusive) deadlineIssues.push("承诺截止缺失");
    if (before("shipping_limit_min","approved_at")) deadlineIssues.push("交运截止早于批准");
    if (row.shipping_limit_max && row.promise_end_exclusive && String(row.shipping_limit_max).replace("T"," ") >= String(row.promise_end_exclusive).replace("T"," ")) deadlineIssues.push("至少一条商品行的交运截止达到或晚于承诺收货截止");
    issues.push(`截止时间待核查：${deadlineIssues.length ? deadlineIssues.join("；") : "交运截止未通过合理性校验"}。`);
  }
  const known = row.timeline_valid != null && row.shipping_deadline_valid != null;
  const status = issues.length ? badge("需核查","orange") : badge(known ? "关键时间校验通过" : "质量标记未提供",known ? "teal" : "neutral");
  const summary = issues.length ? issues.join(" ") : known ? "关键事件时间完整且先后有效，交运截止通过合理性校验。" : "数据服务尚未提供本单时间质量标记，不能据此推断正常。";
  return `<section class="drawer-section"><h3>历史数据质量 ${status}</h3><div class="detail-quality"><p>${esc(summary)}</p><p>完整时间线与晚收货分别判断有效性；上述标记不会自动把本单改判为晚到或按期。晚收货结果仍按本单下单、实际收货与承诺日期的有效口径判断。</p></div></section>`;
}

function renderDetail(data) {
  const row=data.order, replay=data.mode==="replay", action=data.action || {status:"pending",note:""}, task=data.alerts?.[0];
  const stat=(name,value)=>`<div><dt>${esc(name)}</dt><dd>${value}</dd></div>`;
  const metadata=[
    stat("收货地区",esc(row.customer_state || "未提供")),
    stat(replay?"当前可见阶段":"最终订单状态",esc(replay?(labels.stage[row.stage]||"已见事件"):(labels.status[row.order_status]||row.order_status))),
    stat("整单商品金额",row.item_amount_cents==null?"暂不可见":`${money(row.item_amount_cents)} BRL`),
    stat("整单运费",row.freight_amount_cents==null?"暂不可见":`${money(row.freight_amount_cents)} BRL`),
    stat("承诺收货日期",esc(row.estimated_at?String(row.estimated_at).slice(0,10):"暂不可见")),
    stat("承诺截止（不含）",esc(row.promise_end_exclusive?dateTime(row.promise_end_exclusive):"暂不可见"))
  ];
  if (!replay) {
    metadata.push(stat("历史履约结果",lateBadge(row)));
    metadata.push(stat("选定订单评分",row.review_valid && row.review_score!=null?`${num(row.review_score)} / 5`:"无有效评价"));
    metadata.push(stat("订单商品行 / 商家数",`${num(row.item_count)} 条 / ${num(row.seller_count)} 个`));
    metadata.push(stat("付款记录总额",row.payment_amount_cents==null?"无记录":`${money(row.payment_amount_cents)} BRL（非结算收入）`));
  }
  const items=(data.items || []).map(item=>`<div class="drawer-item"><strong>${esc(categoryLabel(item.category))}</strong><span class="item-price">${money(item.price_cents)} BRL</span><div>第 ${num(item.order_item_id)} 条商品行 · 运费 ${money(item.freight_cents)} BRL</div><div>商家 ${esc(item.seller_id)}<br>交运截止 ${esc(dateTime(item.shipping_limit_at))}</div></div>`).join("");
  $("#drawer-subtitle").textContent=replay?`历史模拟 · ${dateTime(data.as_of).slice(0,16)}`:"真实历史详情 · 完整事件记录";
  $("#drawer-content").innerHTML=`
    <div class="drawer-context">${badge(replay?"历史模拟":"历史订单",replay?"teal":"blue")}${replay?`<p>业务事件只显示到所选历史时点；本地处置是当前演示动作。</p>`:lateBadge(row)}</div>
    ${replay?`<section class="drawer-section issue-summary"><h3>异常与核查建议</h3>${task?ruleDetails(task):empty("此刻没有触发规则","事件已经可见或尚未达到截止条件。")}</section>`:historicalQualityHTML(row)}
    <section class="drawer-section"><h3>订单基本信息</h3><p class="drawer-order-id">${esc(row.order_id)}</p><dl class="detail-grid">${metadata.join("")}</dl></section>
    <section class="drawer-section"><h3>${replay?"时点内可见事件":"历史事件时间线"}</h3>${timelineHTML(data)}${replay?`<p class="drawer-note">${!row.carrier_at?"尚未看到交承运商事件。":""} ${!row.delivered_at?"尚未看到收货事件。":""} 静态截止以批准后可见且不修改为模拟假设。</p>`:""}</section>
    <details class="drawer-items-details"><summary>商品记录 <span class="count-label">${num(data.items?.length)} 条</span></summary>${items?`<div class="drawer-items">${items}</div>`:empty("暂无可见商品信息",replay?"商品属性假设在批准后可见。":"原始数据没有该订单商品行。")}</details>
    <section class="drawer-section action-section"><h3>记录模拟处置 ${actionBadge(action.status)}</h3><form class="action-form" id="action-form" novalidate><label for="action-status">处置状态</label><select id="action-status" name="status">${Object.entries(labels.action).map(([value,label])=>`<option value="${value}" ${action.status===value?"selected":""}>${label}</option>`).join("")}</select><label id="action-note-label" for="action-note">处理备注${action.status==="ignored"?"（忽略时必填）":"（可选）"}</label><textarea id="action-note" name="note" maxlength="2000" ${action.status==="ignored"?"required":""} aria-describedby="action-error" placeholder="记录核查事项；忽略任务时说明原因">${esc(action.note)}</textarea><div id="action-error" class="form-error" role="alert" hidden></div><p class="drawer-note">这是当前演示的处置记录，不随历史时点回滚，不改变原始履约事件。</p></form><div class="action-history"><p class="cell-sub">最近保存 ${esc(localSavedTime(action.updated_at))} · 当前设备时间</p>${data.action_history?.length?`<details><summary>查看最近 ${num(Math.min(data.action_history.length,8))} 次处置记录</summary>${data.action_history.slice(0,8).map(record=>`<div class="action-record"><strong>${esc(labels.action[record.status] || record.status)}</strong><time>${esc(localSavedTime(record.updated_at))}</time><p>${esc(record.note || "未填写备注")}</p></div>`).join("")}</details>`:""}</div></section>
    <p class="drawer-note">${replay?"回放样本为最终成功妥投、单商品行且有效时间订单，存在事后选择偏差。":"履约与评分是订单整体结果，不能拆成各商家的独立责任或体验。"} 模拟处置仅存本地，不改变原始数据，不发送真实消息。</p>`;
  $("#drawer-footer").hidden=false;$("#drawer-save").disabled=false;$("#drawer-save").textContent="保存模拟处置";
  $("#action-status").addEventListener("change",event=> {
    const ignored=event.target.value==="ignored";
    $("#action-note").required=ignored;
    $("#action-note-label").textContent=`处理备注${ignored?"（忽略时必填）":"（可选）"}`;
    formError("#action-error", "", ["#action-note"]);
  });
  $("#action-note").addEventListener("input",()=>formError("#action-error","",["#action-note"]));
  $("#action-form").addEventListener("submit",saveAction);
}

async function openDetail(orderId,mode) {
  const version=++app.detailRequest;
  if (!app.drawer) app.lastFocus=document.activeElement;
  app.drawer={orderId,mode,as_of:mode==="replay"?app.replayFilters.as_of:null};
  $("#drawer-overlay").hidden=false;$("#order-drawer").hidden=false;
  $("#drawer-footer").hidden=true;
  $(".app-shell").inert=true;hideChartTooltip();
  document.body.classList.add("drawer-open");
  loading("#drawer-content","正在核对订单事件…");
  $("#drawer-close").focus();
  try {
    const values={mode};if(mode==="replay")values.as_of=app.drawer.as_of;
    const data=await request(`/api/order/${encodeURIComponent(orderId)}`,values);
    if(version!==app.detailRequest || !app.drawer)return;
    app.drawer.data=data;renderDetail(data);
  } catch(error) {
    if(version!==app.detailRequest || !app.drawer)return;
    $("#drawer-content").innerHTML=errorHTML(error,"detail");
  }
}

function closeDetail() {
  const closed=app.drawer;
  ++app.detailRequest;app.drawer=null;
  $("#drawer-overlay").hidden=true;$("#order-drawer").hidden=true;
  $("#drawer-footer").hidden=true;$(".app-shell").inert=false;
  document.body.classList.remove("drawer-open");
  const currentButton=$$("button[data-order]").find(button=>button.dataset.order===closed?.orderId && button.dataset.mode===closed?.mode && button.offsetParent!==null);
  const previous=app.lastFocus;
  (currentButton || (previous?.isConnected && previous.offsetParent!==null?previous:null) || $(".nav-link.active"))?.focus();
}

async function saveAction(event) {
  event.preventDefault();
  if(!app.drawer)return;
  const form=event.currentTarget,values=Object.fromEntries(new FormData(form).entries()),note=values.note.trim(),errorEl=$("#action-error");
  if(values.status==="ignored" && !note){formError("#action-error","请填写忽略原因，便于后续复核。",["#action-note"]);$("#action-note").focus();return;}
  if(note.length>2000){formError("#action-error","处理备注最多2000个字符。",["#action-note"]);$("#action-note").focus();return;}
  const button=$("#drawer-save"),orderId=app.drawer.orderId;
  button.disabled=true;button.textContent="正在保存…";errorEl.hidden=true;
  try {
    const result=await request("/api/action",{},{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({order_id:orderId,status:values.status,note})});
    toast(result.changed?"模拟处置已保存；刷新后保留。历史订单结果不变。":"处置与已有记录相同，未重复创建记录。");
    if(app.drawer?.orderId===orderId) {
      const mode=app.drawer.mode,as_of=app.drawer.as_of,scroll=$("#drawer-content").scrollTop;
      try {
        const data=await request(`/api/order/${orderId}`,mode==="replay"?{mode,as_of}:{mode});
        if(app.drawer?.orderId===orderId){app.drawer.data=data;renderDetail(data);$("#drawer-content").scrollTop=scroll;$("#drawer-save").focus();}
      } catch(refreshError) {
        if(app.drawer?.orderId===orderId){errorEl.textContent=`处置已经保存，但详情刷新失败：${refreshError.message}`;errorEl.hidden=false;button.disabled=false;button.textContent="保存模拟处置";}
      }
    }
    if(app.page==="workbench")await loadReplay();
  } catch(error) {
    if(app.drawer?.orderId===orderId){errorEl.textContent=error.message;errorEl.hidden=false;button.disabled=false;button.textContent="保存模拟处置";}
  }
}

  return {ruleDetails,timelineHTML,historicalQualityHTML,renderDetail,openDetail,closeDetail,saveAction};
}
