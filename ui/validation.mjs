/** validation: preserved V1 templates and request sequence guards, with injected services. */
export function createValidation(ctx) {
  const {$,app,request,esc,num,pct,dateTime,badge,ruleClass,labels,loading,empty,errorHTML}=ctx;

function renderRuleCards(report) {
  const config=report?.config_snapshot || {}, shipping=config.shipping_warning_hours, delivery=config.delivery_warning_hours;
  $("#rules-version").textContent = report?.rule_version || app.meta?.replay?.rule_version || "版本待读取";
  if (!report) { $("#rule-cards").innerHTML=empty("规则报告暂不可用","读取验证报告后展示已冻结的阈值与条件。"); return; }
  const rules=[
    ["R1","提示",`已批准，尚未看到交运或收货事件；距交运截止0—${num(shipping)}小时，包含截止时刻。`,"核对备货与交接安排。"],
    ["R2","紧急",`已批准，尚未看到交运或收货事件；历史时点已严格超过交运截止。`,"先核查是否已交运但事件未更新。"],
    ["R3","关注",`已批准，尚未看到收货事件；处于承诺日期结束前${num(delivery)}小时内，且尚未到截止。`,"核查物流进展；高覆盖不代表预测能力。"],
    ["R4","逾期监控",`已批准，尚未看到收货事件；已达到或超过承诺日期结束时刻。`,"登记并核查，不计为提前提示成功。"]
  ];
  $("#rule-cards").innerHTML=rules.map(([code,level,condition,suggestion])=>{
    const result=report.summaries?.find(row=>row.window==="holdout" && row.rule===(code==="R4"?"R4_MONITOR_ONLY":code));
    return `<article class="rule-card ${ruleClass(code)}"><div class="rule-card-header"><span class="rule-code">${code}</span><span class="rule-level">${esc(level)}</span></div><h3>${labels.rule[code]}</h3><div class="rule-condition">${esc(condition)}</div><p>建议检查：${esc(suggestion)}</p><div class="rule-result">留出样本触发 <strong>${result?num(result.all_triggered_orders):"—"}</strong> 单${code==="R4"?" · 逾期后监控":""}</div></article>`;
  }).join("");
  renderValidationHighlights(report);
}

function renderValidationHighlights(report) {
  const primary=report.summaries?.find(row=>row.window==="holdout" && row.rule==="SHIPPING_R1_R2");
  if(!primary) {$("#validation-highlights").innerHTML=empty("尚无留出结果","先运行历史验证，再读取真实计算结果。");return;}
  $("#validation-highlights").innerHTML=`<section class="panel validation-highlight-panel"><div class="panel-header"><div><h2>交运提示：覆盖与处理负担要一起看</h2><p>2018年8月冻结留出窗口 · R1+R2合并 · 每个订单只计一次</p></div></div><div class="validation-highlight-grid"><article class="validation-highlight coverage"><div class="metric-label">晚收货订单提前覆盖</div><div class="metric-value">${pct(primary.late_advance_coverage)}</div><p>在 <strong>${num(primary.L)}</strong> 个最终晚收货订单中，<strong>${num(primary.A_intersection_L)}</strong> 个曾在承诺截止前收到交运提示。</p><div class="fraction-note">${num(primary.A_intersection_L)} ÷ ${num(primary.L)} 个晚收货订单</div></article><article class="validation-highlight hit-share"><div class="metric-label">提示命中比例</div><div class="metric-value">${pct(primary.hint_hit_share)}</div><p>在 <strong>${num(primary.A_before_promise)}</strong> 个收到提示的订单中，<strong>${num(primary.A_intersection_L)}</strong> 个最终晚收货。</p><div class="fraction-note">${num(primary.A_intersection_L)} ÷ ${num(primary.A_before_promise)} 个提示订单</div></article></div><div class="evidence-stat-strip"><div><span>合格样本</span><strong>${num(primary.E)} 单</strong><small>全部窗口 ${num(primary.all_window_orders)} 单 · 覆盖 ${pct(primary.eligible_share,1)}</small></div><div><span>命中订单提前量中位数</span><strong>${num(primary.hits_advance_hours_median,1)} 小时</strong><small>距承诺截止，不是节省的时间</small></div><div><span>每千合格样本提示量</span><strong>${num(primary.hints_per_1000_E,1)} 单</strong><small>用于评估跟进负担</small></div></div><div class="evidence-conclusion"><strong>产品判断</strong><p>交运提示提供核查线索，仍需控制跟进量。两项百分比的分母不同；这是选择后的历史样本结果，没有证明真实延误下降。</p></div></section>`;
}

function renderEvaluation(report) {
  const config=report.config_snapshot || {}, summaries=report.summaries || [];
  if (!summaries.length) { $("#evaluation-content").innerHTML=empty("尚无历史验证结果","先运行回放验证，再查看真实计算出的指标。这里不会预填模拟成绩。"); return; }
  const holdout=summaries.filter(row=>row.window==="holdout"), primary=holdout.find(row=>row.rule==="SHIPPING_R1_R2") || holdout[0];
  const windows=[
    ["exploration",config.exploration_start,config.exploration_end_exclusive],
    ["validation",config.validation_start,config.validation_end_exclusive],
    ["holdout",config.holdout_start,config.holdout_end_exclusive]
  ].map(([name,start,end])=> {
    const result=summaries.find(row=>row.window===name);
    return `<article class="window-card ${name}"><div class="window-title">${labels.window[name]}</div><strong>${esc(start || "—")} 至 ${esc(end || "—")} 前</strong><small>${result ? `合格 ${num(result.E)} / ${num(result.all_window_orders)} 单 · ${pct(result.eligible_share,1)}` : "尚无结果"}</small></article>`;
  }).join("");
  const lead=value=>value==null?"—":`${num(value,1)} 小时`;
  const results=holdout.map(row=>`<tr><td>${esc(labels.rule[row.rule] || row.rule)}<div class="cell-sub">${row.rule==="R3"?"截止定义性监控":row.rule==="R4_MONITOR_ONLY"?"逾期后发现":"样本内描述性关联"}</div></td><td class="numeric">${num(row.A_before_promise)}<div class="cell-sub">触发总量 ${num(row.all_triggered_orders)}</div></td><td class="numeric">${pct(row.hint_hit_share)}<div class="cell-sub">${num(row.A_intersection_L)} / ${num(row.A_before_promise)}</div></td><td class="numeric">${pct(row.late_advance_coverage)}<div class="cell-sub">${row.late_advance_coverage == null ? "不属于提前提示" : `${num(row.A_intersection_L)} / ${num(row.L)}`}</div></td><td class="numeric">${num(row.hints_per_1000_E,1)}</td><td class="numeric">${lead(row.hits_advance_hours_median)}</td></tr>`).join("");
  const waterfall=report.filter_audits?.holdout || report.waterfalls?.holdout || report.waterfall?.holdout;
  const outcome=report.outcome_audits?.holdout || {}, followup=report.followup?.holdout || {};
  const cutoff=config.outcome_cutoff_exclusive || "未提供";
  $("#evaluation-content").innerHTML=`
    <div class="evaluation-banner"><h3>历史模拟结果 ≠ 真实业务改善</h3><p>规则在留出窗口评价前冻结，按整点小时触发；仅评价最终已妥投、单商品行且时间有效的订单。提前量是距承诺截止的时间，不是节省时间或减少的延误。</p></div>
    <div class="evaluation-windows">${windows}</div>
    ${primary ? `<div class="metric-grid"><article class="metric-card"><div class="metric-label">留出合格样本</div><div class="metric-value">${num(primary.E)}<small>单</small></div><div class="metric-detail">窗口全部订单 ${num(primary.all_window_orders)}</div><div class="metric-sub">合格覆盖 ${pct(primary.eligible_share,1)}</div></article><article class="metric-card"><div class="metric-label">合格样本晚收货</div><div class="metric-value">${num(primary.L)}<small>单</small></div><div class="metric-detail">分母 ${num(primary.E)} 单</div><div class="metric-sub">事后评价标签，不传入回放</div></article><article class="metric-card teal"><div class="metric-label">交运提示命中比例 · R1+R2</div><div class="metric-value">${pct(primary.hint_hit_share)}</div><div class="metric-detail">${num(primary.A_intersection_L)} / ${num(primary.A_before_promise)} 提示订单</div><div class="metric-sub">不是线上准确率</div></article><article class="metric-card orange"><div class="metric-label">交运提示晚到覆盖 · R1+R2</div><div class="metric-value">${pct(primary.late_advance_coverage)}</div><div class="metric-detail">${num(primary.A_intersection_L)} / ${num(primary.L)} 晚到订单</div><div class="metric-sub">分规则可重叠，不能相加</div></article></div>` : ""}
    <section class="panel"><div class="panel-header"><div><h2>冻结留出窗口 · 分规则结果</h2><p>提示在承诺截止前发生；逾期监控单独评价。合并规则以订单去重。</p></div>${badge(report.rule_version,"blue")}</div><div class="table-scroll" tabindex="0" role="region" aria-label="冻结留出窗口规则验证表，可横向滚动查看命中比例、覆盖率与提前量"><table class="data-table"><thead><tr><th scope="col">规则 / 评价性质</th><th scope="col" class="numeric">提前提示订单</th><th scope="col" class="numeric">样本内命中比例</th><th scope="col" class="numeric">晚到提前覆盖</th><th scope="col" class="numeric">每千样本提示量</th><th scope="col" class="numeric">命中提前量中位数</th></tr></thead><tbody>${results}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看完整规则结果与各项分母。</div><div class="table-description">命中比例 = 提示后最终晚到订单 / 截止前提示订单；覆盖 = 提示后最终晚到订单 / 合格晚到订单。未最终晚到的提示不等于已经证明无效，数据没有人工判断记录。</div></section>
    <details class="evidence-details"><summary>展开：样本筛选、观察边界与R3解释</summary><div class="data-note-grid"><article class="note-card"><h3>R3的高覆盖应怎样理解</h3><p>最终晚收货的订单在承诺日期结束前一天通常尚未收货，因此满足“截止前${num(config.delivery_warning_hours)}小时尚未看到收货”的条件。高覆盖主要由规则与晚到定义共同决定，不能包装成预测模型表现；它更适合最后一天的物流核查。</p></article><article class="note-card"><h3>观察边界与不可判定结果</h3><p>人工观察边界 C：${esc(dateTime(cutoff))}（不含）。这不是已知的完整抽取时刻。留出窗口最终未妥投、无完整收货结果 ${num(outcome.final_snapshot_not_delivered_no_complete_delivery_outcome || 0)} 单；边界后收货 ${num(outcome.recorded_delivery_at_or_after_C_right_censored_for_replay || 0)} 单，单独保留，不填为按期。</p><p>窗口承诺截止达到或晚于C：${num(followup.promise_at_or_after_C_orders)} 单。仅有已观察到的可靠收货结果可以评价；不由此声称末期观察完整。</p></article></div>${waterfall ? renderWaterfall(waterfall) : ""}</details>
    <details class="evidence-details"><summary>展开：后续真实验证与复现信息</summary><ul class="note-list"><li>样本经过事后筛选，排除了未收货、取消、多商品行和异常时间订单，不能外推全量生产队列或总体精准率。</li><li>假设截止和商品属性在批准后已知且不变；假设事件在记录时刻立刻可见。源数据缺少修改历史与入库延迟。</li><li>先开展真实目标用户任务测试，记录理解与操作错误；再在接入真实状态日志后影子运行，核查重复、漏报与跟进负担。</li><li>业务改善必须在获授权的真实试点中评估，对照处理效率、人工工作量与晚到结果，保留同期对照及混杂因素。</li></ul><div class="table-description">配置摘要：${esc(report.config_sha256 || "未提供")} · 生成时间 ${esc(report.generated_at || "未提供")}</div></details>`;
}

function renderWaterfall(waterfall) {
  const survivors=waterfall.survivors || {}, removed=waterfall.removed_at_step || {};
  return `<section class="panel"><div class="panel-header"><div><h2>留出窗口样本筛选</h2><p>每一步记录保留量与排除量；不是静默删除原始数据。</p></div></div><div class="waterfall">${Object.entries(survivors).map(([key,value])=>`<div class="waterfall-row"><span class="waterfall-name">${esc(labels.waterfall[key] || key)}</span><strong>${num(value)} 单</strong><small>${key==="all_window_orders"?"起始样本":`本步排除 ${num(removed[key])}`}</small></div>`).join("")}</div></section>`;
}

function renderQuality(data) {
  const rows=data.raw_rows || {}, flags=data.order_flags || {}, review=data.review_checks || {};
  const selected=Object.entries(labels.quality).filter(([key])=>flags[key]!=null);
  const issues=selected.map(([key,label])=>`<tr><td>${esc(label)}</td><td class="numeric">${num(flags[key])}</td><td>标记并按指标判断，不统一填零或删除</td></tr>`).join("");
  $("#quality-content").innerHTML=`<div class="data-note-grid"><article class="note-card"><h3>一单一行的数据底座</h3><p>原始订单 ${num(rows.orders)} 条，订单事实表 ${num(data.fact_rows?.orders)} 行。商品、付款与评价分别聚合后连接，避免一单多商品、多付款导致金额膨胀。</p><p>订单—商家事实表 ${num(data.fact_rows?.order_sellers)} 行；金额只归属商家商品行，订单级评分和履约事件不能复制成商家独立结果。</p></article><article class="note-card"><h3>评价时点与选择规则</h3><p>选择订单最新有效答复：评分1—5分，回答不早于下单，调查创建日期不早于下单日期。重复订单评价 ${num(review.order_id_repeated_rows_after_first)} 条，无效答复记录 ${num(review.invalid_answer_record_rows)} 条；保留覆盖率。</p><p>答复可能发生在收货前；对“收货后答复”的敏感性分析另行复核。评分与晚收货的关联不证明延误导致低分，也不输入预警触发。</p></article></div><section class="panel"><div class="panel-header"><div><h2>原始数据质量标记</h2><p>以下为全数据的订单级标记，彼此可能重叠；不等于当前筛选订单数。</p></div>${badge(data.aggregate_reconciliation_passed?"聚合对账通过":"对账待确认",data.aggregate_reconciliation_passed?"teal":"orange")}</div><div class="table-scroll" tabindex="0" role="region" aria-label="原始数据质量标记表，可横向滚动查看订单数与处理原则"><table class="data-table"><thead><tr><th scope="col">标记项</th><th scope="col" class="numeric">订单数</th><th scope="col">处理原则</th></tr></thead><tbody>${issues}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看质量标记、订单数与处理原则。</div><div class="table-description">没有商品行时保留订单、不计金额；未来或倒序时间进入质量核查；截止缺失不自动推断违约。付款记录与商品加运费存在差额，不强行改成一致。</div></section>`;
  renderSource();
}

function renderSource() {
  const source=app.meta?.source;
  if (!source) return;
  $("#data-source").innerHTML=`数据来源：<a href="https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce" target="_blank" rel="noopener noreferrer">Olist Brazilian E-Commerce Public Dataset</a> · version ${num(source.version)} · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">${esc(source.license)}</a>。匿名化真实商业数据的独立学习实践；非商业展示、署名及衍生数据分享遵循数据许可。自写程序与数据许可分开。<br>原始ZIP SHA-256：${esc(source.sha256)}。原始时间没有显式时区，本Demo不转换业务事件时区。`;
}

async function loadValidation() {
  const version=++app.validationRequest;
  $("#validation-reload").disabled=true;
  loading("#rule-cards","正在读取冻结规则与回放证据…");loading("#validation-highlights");loading("#evaluation-content");loading("#quality-content");
  const results=await Promise.allSettled([request("/api/replay_report"),request("/api/quality")]);
  if (version!==app.validationRequest) return;
  if (results[0].status==="fulfilled") { renderRuleCards(results[0].value);renderEvaluation(results[0].value); }
  else { $("#rule-cards").innerHTML=errorHTML(results[0].reason,"validation");$("#validation-highlights").innerHTML="";$("#evaluation-content").innerHTML=errorHTML(results[0].reason,"validation"); }
  if (results[1].status==="fulfilled") renderQuality(results[1].value);
  else $("#quality-content").innerHTML=errorHTML(results[1].reason,"validation");
  app.validationLoaded=results.every(result=>result.status==="fulfilled");
  $("#validation-reload").disabled=false;
}

  return {renderRuleCards,renderValidationHighlights,renderEvaluation,renderWaterfall,renderQuality,renderSource,loadValidation};
}
