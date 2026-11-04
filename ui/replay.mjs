/** replay: preserved V1 templates and request sequence guards, with injected services. */
export function createReplay(ctx) {
  const {$,app,request,esc,num,dateTime,shortId,categoryLabel,actionBadge,ruleClass,hoursText,labels,loading,empty,errorHTML,formBusy}=ctx;
  const renderPagination=(...args)=>ctx.renderPagination(...args);
function deadlineHTML(task) {
  const shipping=["R1","R2"].includes(task.primary_rule),value=shipping?task.hours_to_shipping_deadline:task.hours_to_promise_end,name=shipping?"交运截止":"承诺截止",at=shipping?task.shipping_deadline_at:task.promise_end_exclusive;
  return `<strong class="time-primary">${esc(hoursText(value,name))}</strong><div class="time-exact">${Number(value)<0?"已超时":"距截止"} ${num(Math.abs(Number(value)),1)} 小时</div><div class="cell-sub">截止 ${esc(dateTime(at).slice(0,16))}${shipping?"":"（不含）"}</div>${Number(value)<-168?`<div class="long-delay-note">较长历史逾期 · 需核查事件记录</div>`:""}`;
}

function renderReplay(data) {
  const counts = data.counts || {}, total = ["pending","processing","resolved","ignored"].reduce((sum,key)=>sum+(Number(counts[key])||0),0);
  $("#replay-summary").innerHTML=`<div class="summary-card task-total"><div class="summary-label">去重跟进任务</div><div class="summary-value">${num(total)}<small>单</small></div><small>历史时点 ${esc(dateTime(data.as_of).slice(0,16))}</small></div><div class="summary-card task-before"><div class="summary-label">承诺截止前提示</div><div class="summary-value">${num(counts.before_promise_hint)}<small>单</small></div><small>核查风险，尚不能判断未来结果</small></div><div class="summary-card task-overdue"><div class="summary-label">承诺逾期监控</div><div class="summary-value">${num(counts.overdue_monitoring)}<small>单</small></div><small>截止已过，不计为提前提示成功</small></div><div class="summary-card task-status-card"><div class="summary-label">本地模拟处置</div><div class="summary-statuses status-count-grid">${["pending","processing","resolved","ignored"].map(status=>`<div class="status-count ${status}"><span>${esc(labels.action[status])}</span><strong>${num(counts[status])}</strong></div>`).join("")}</div><small>以上计数在异常类型与处置筛选前</small></div>`;
  $("#queue-total").textContent = `${num(data.total)} 个匹配任务`;
  if (!(data.alerts || []).length) {
    $("#queue-table").innerHTML = empty("这一时点没有匹配任务", "当前有效样本未触发规则，或被业务与处置状态筛选排除。没有任务不代表全量业务没有异常。", "✓");
  } else {
    $("#queue-table").innerHTML = `<div class="table-scroll" tabindex="0" role="region" aria-label="履约跟进任务表，可横向滚动查看截止、状态与详情操作"><table role="table" class="data-table queue-table"><thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">订单 / 可见阶段</th><th role="columnheader" scope="col">异常类型与原因</th><th role="columnheader" scope="col">截止与逾期</th><th role="columnheader" scope="col">跟进优先级</th><th role="columnheader" scope="col">处理状态</th><th role="columnheader" scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody role="rowgroup">` + data.alerts.map(task => {
      const row = task.order || {},others=(task.matched_rules || [task.primary_rule]).filter(code=>code!==task.primary_rule);
      return `<tr role="row"><td role="cell"><span class="order-id" title="${esc(task.order_id)}">${esc(shortId(task.order_id,10))}</span><div class="cell-sub">${esc(labels.stage[row.stage] || "已见订单事件")}</div><div class="cell-sub">收货 ${esc(row.customer_state || "未知州")} · ${esc(categoryLabel(row.single_category))}</div></td><td role="cell"><strong class="task-type ${ruleClass(task.primary_rule)}">${esc(labels.rule[task.primary_rule])}</strong><div class="task-reason">${esc(task.reason)}</div><div class="rule-inline">${esc(task.primary_rule)}${others.length?` · 同时触发 ${esc(others.join("、"))}`:""}</div></td><td role="cell">${deadlineHTML(task)}</td><td role="cell"><span class="priority ${["R2","R4"].includes(task.primary_rule)?"high":""}"><i class="priority-dot" aria-hidden="true"></i>${esc(task.level)}</span><div class="cell-sub">${task.kind === "overdue_monitoring" ? "逾期后核查" : "截止前跟进"}</div></td><td role="cell">${actionBadge(task.action?.status || "pending")}<div class="cell-sub">${task.action?.updated_at ? "本地已保存" : "尚未处置"}</div></td><td role="cell"><button type="button" class="detail-button" data-order="${esc(task.order_id)}" data-mode="replay" aria-label="查看订单${esc(shortId(task.order_id,10))}详情">查看详情</button></td></tr>`;
    }).join("") + `</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看截止、状态与操作。</div>`;
  }
  renderPagination("#queue-pagination",data,"queue");
}

async function loadReplay() {
  const version = ++app.replayRequest;
  formBusy("#replay-filters",true);
  loading("#queue-table","正在按历史时点重建可见事件…");
  $("#queue-pagination").innerHTML=""; $("#replay-summary").innerHTML="";
  try {
    const data = await request("/api/alerts", {...app.replayFilters,page:app.queuePage,limit:10,rule:$("#queue-rule-filter").value,action_status:$("#queue-status-filter").value || "all"});
    if (version !== app.replayRequest) return;
    app.replay = data; renderReplay(data);
  } catch(error) {
    if (version !== app.replayRequest) return;
    $("#queue-table").innerHTML=errorHTML(error,"replay");$("#queue-total").textContent="";
  } finally {if(version===app.replayRequest)formBusy("#replay-filters",false);}
}

  return {deadlineHTML,renderReplay,loadReplay};
}
