"use strict";

/* All business values come from the versioned Olist export, queried in a worker. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const app = {
  meta: null, page: "overview", overview: null, orders: null, replay: null,
  overviewFilters: {}, replayFilters: {}, orderPage: 1, queuePage: 1,
  overviewRequest: 0, ordersRequest: 0, replayRequest: 0, detailRequest: 0,
  validationRequest: 0, validationLoaded: false, drawer: null, lastFocus: null,
  toastTimer: null, chartWidth: 0, defaultStart: "2017-01-01", defaultEnd: "2018-06-30"
};
const labels = {
  status: {created:"已创建",approved:"已批准",invoiced:"已开票",processing:"处理中",shipped:"已发出",delivered:"已妥投",canceled:"已取消",unavailable:"不可用"},
  action: {pending:"待处理",processing:"处理中",resolved:"已处理",ignored:"已忽略"},
  stage: {purchased:"已下单",approved:"已批准 · 待交运",handed_to_carrier:"已交承运商 · 待收货",delivered:"已收货"},
  rule: {R1:"交运截止临近",R2:"交运截止已过",R3:"承诺收货日临近",R4:"承诺收货截止已过",SHIPPING_R1_R2:"交运提示合并 R1+R2",COMBINED_R1_R2_R3:"截止前提示合并 R1+R2+R3",R4_MONITOR_ONLY:"逾期监控 R4"},
  window: {exploration:"探索窗口",validation:"调试窗口",holdout:"冻结留出窗口"},
  waterfall: {all_window_orders:"窗口全部下单订单",final_delivered:"最终状态为已妥投",single_item_row:"仅一条商品行",timestamps_available:"关键时间字段齐全",timeline_valid:"事件先后顺序有效",shipping_deadline_valid:"交运与收货截止合理",late_valid:"晚收货结果有效",delivered_before_C:"在人工观察边界前收货"},
  quality: {no_item_records:"没有商品记录",no_payment_records:"没有付款记录",multiple_sellers:"涉及多个商家",carrier_before_approval:"交运记录早于批准",delivery_before_carrier:"收货记录早于交运",shipping_before_approval:"交运截止早于批准",shipping_after_promise:"交运截止晚于收货承诺",shipping_after_2018:"交运截止晚于2018年",delivered_status_missing_delivery_event:"已妥投却缺收货事件",invalid_review_record:"无效评价答复记录"},
  category: {unknown:"未知品类",health_beauty:"健康与美容",bed_bath_table:"床品、卫浴与餐桌",sports_leisure:"运动休闲",furniture_decor:"家具与装饰",computers_accessories:"电脑配件",housewares:"家居用品",watches_gifts:"钟表与礼品",telephony:"通信设备",auto:"汽车用品",toys:"玩具",cool_stuff:"潮流用品",garden_tools:"园艺工具",perfumery:"香水",baby:"婴儿用品",electronics:"电子设备",stationery:"文具",fashion_bags_accessories:"包袋与配饰",pet_shop:"宠物用品",office_furniture:"办公家具",consoles_games:"游戏主机",luggage_accessories:"箱包配件",musical_instruments:"乐器",home_appliances:"家用电器",food:"食品",books_general_interest:"大众图书",home_construction:"家装建材"}
};

function esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function num(value, digits = 0) { return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", {minimumFractionDigits:digits, maximumFractionDigits:digits}); }
function pct(value, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? "—" : `${num(Number(value) * 100, digits)}%`; }
function money(cents) { return cents == null || !Number.isFinite(Number(cents)) ? "—" : num(Number(cents) / 100, 2); }
function dateTime(value) { return value ? String(value).replace("T", " ").slice(0, 19) : "无有效记录"; }
function localSavedTime(value) {
  if (!value) return "尚未保存";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? dateTime(value) : parsed.toLocaleString("zh-CN", {hour12:false});
}
function shortId(value, length = 10) { return value ? String(value).slice(0, length) + "…" : "—"; }
function categoryLabel(value) { return labels.category[value] || value || "未知品类"; }
function badge(text, type = "neutral") { return `<span class="badge ${esc(type)}">${esc(text)}</span>`; }
function lateBadge(row) { return Number(row.late_valid) === 1 ? (Number(row.is_late) === 1 ? badge("晚收货","orange") : badge("按期收货","teal")) : badge("不可判定"); }
function actionBadge(status) { return `<span class="task-status ${esc(status || "pending")}"><i aria-hidden="true"></i>${esc(labels.action[status] || "待处理")}</span>`; }
function ruleClass(code) { return ["R2","R4"].includes(code) ? "critical" : "warning"; }
function formValues(id) { return Object.fromEntries(new FormData($(id)).entries()); }
function query(values) { const result = new URLSearchParams(); for (const [key, value] of Object.entries(values)) if (value !== "" && value != null) result.set(key, value); return result.toString(); }
async function request(path, values = {}, options = {}) {
  if (!window.OlistAPI) throw new Error("数据组件尚未加载，请刷新页面后重试。");
  return window.OlistAPI.request(path, values, options);
}
function loading(id, label = "正在读取数据…") { $(id).innerHTML = `<div class="loading-block" role="status"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`; }
function empty(title, text) { return `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 9h8M8 13h5"/></svg><strong>${esc(title)}</strong><small>${esc(text)}</small></div>`; }
function errorHTML(error, retry) { return `<div class="inline-error" role="alert"><strong>暂时无法读取</strong><p>${esc(error.message || error)}</p>${retry ? `<button class="button subtle" data-retry="${esc(retry)}">重新读取</button>` : ""}</div>`; }
function toast(text) { clearTimeout(app.toastTimer); const el = $("#toast"); el.textContent = text; el.hidden = false; app.toastTimer = setTimeout(() => { el.hidden = true; }, 4500); }
function cardSkeletons() { return Array.from({length:4}, () => `<article class="metric-card" aria-hidden="true"><div class="skeleton short"></div><div class="skeleton large"></div><div class="skeleton"></div><div class="skeleton short"></div></article>`).join(""); }
function formError(id, message, fields = []) {
  const element = $(id);
  element.textContent = message || "";
  element.hidden = !message;
  fields.forEach(field => { if (message) $(field).setAttribute("aria-invalid","true"); else $(field).removeAttribute("aria-invalid"); });
}
function formBusy(id, busy) {
  $(id).setAttribute("aria-busy",String(busy));
  const button=$("button[type=submit]",$(id));
  if (button) button.disabled=busy;
}
function validateOverview(values) {
  const fields=["#overview-start","#overview-end"];
  if (!values.start || !values.end) {formError("#overview-filter-error","请选择完整的下单日期范围。",fields);return false;}
  if (values.start>values.end) {formError("#overview-filter-error","开始日期不能晚于结束日期，请调整日期范围。",fields);$("#overview-start").focus();return false;}
  formError("#overview-filter-error","",fields);return true;
}
function validateReplay(values) {
  if (!values.as_of) {formError("#replay-filter-error","请选择一个完整的历史回放时点。",["#replay-as-of"]);return false;}
  const normalized=values.as_of.replace("T"," "),cutoff=app.meta?.replay?.observation_cutoff || "2018-10-01 00:00:00";
  if(normalized>=cutoff.slice(0,normalized.length)) {formError("#replay-filter-error",`历史时点必须早于 ${dateTime(cutoff)}，这是本项目的人工观察边界。`,["#replay-as-of"]);$("#replay-as-of").focus();return false;}
  formError("#replay-filter-error","",["#replay-as-of"]);return true;
}
function hideChartTooltip() { $("#chart-tooltip").hidden=true; }
function showChartTooltip(element) {
  const tip=$("#chart-tooltip"), row=app.overview?.monthly?.[Number(element.dataset.monthIndex)];
  if (!row) return;
  tip.innerHTML=`<strong>${esc(row.month)} · 下单月份</strong><div>去重订单 <b>${num(row.orders)}</b> 单</div><div>晚收货 <b>${num(row.late_orders)}</b> / <b>${num(row.late_valid_orders)}</b> 有效妥投订单</div><div>晚收货率 <b>${pct(row.late_rate)}</b></div><small>同日收货按期；无效时间不进入分母</small>`;
  tip.hidden=false;
  const rect=element.getBoundingClientRect(), bounds=tip.getBoundingClientRect();
  tip.style.left=`${Math.max(12,Math.min(window.innerWidth-bounds.width-12,rect.left+rect.width/2-bounds.width/2))}px`;
  tip.style.top=`${rect.top>bounds.height+20?rect.top-bounds.height-10:Math.min(window.innerHeight-bounds.height-12,rect.bottom+10)}px`;
}
function selectOptions(selector, values, defaultLabel, format) {
  const select = $(selector), previous = select.value;
  select.innerHTML = `<option value="">${esc(defaultLabel)}</option>` + values.map(value => `<option value="${esc(value.id)}">${esc(format ? format(value) : value.label || value.id)}</option>`).join("");
  select.value = previous;
}

async function loadMeta() {
  try {
    app.meta = await request("/api/meta");
    const meta = app.meta;
    app.defaultStart = meta.dates?.default_analysis_start || app.defaultStart;
    app.defaultEnd = meta.dates?.default_analysis_end || app.defaultEnd;
    $("#overview-start").value = app.defaultStart;
    $("#overview-end").value = app.defaultEnd;
    for (const prefix of ["overview","replay"]) {
      selectOptions(`#${prefix}-seller`, meta.sellers || [], "全部商家", value => `${value.state || ""} · ${shortId(value.id,12)}${value.city ? " · " + value.city : ""}`);
      selectOptions(`#${prefix}-category`, meta.categories || [], "全部品类", value => categoryLabel(value.id));
      selectOptions(`#${prefix}-state`, meta.states || [], "全部州");
    }
    $("#replay-as-of").max=String(meta.replay?.observation_cutoff || "2018-10-01 00:00:00").replace(" ","T").slice(0,16);
    $("#global-error").hidden = true;
    renderSource();
  } catch (error) {
    const el = $("#global-error");
    el.innerHTML = `${esc(error.message)} <button class="button subtle" data-retry="meta">重新连接</button>`;
    el.hidden = false;
  }
}

function setPage(page) {
  if (!["overview","workbench","validation"].includes(page)) page = "overview";
  const changed=page!==app.page;
  app.page = page;
  for (const candidate of ["overview","workbench","validation"]) $(`#page-${candidate}`).hidden = candidate !== page;
  for (const link of $$(".nav-link")) {
    link.classList.toggle("active", link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  $("#breadcrumb-page").textContent = {overview:"经营概览",workbench:"履约工作台",validation:"规则与验证"}[page];
  hideChartTooltip();
  if(changed) { if(app.drawer)closeDetail(); window.scrollTo({top:0,behavior:"auto"}); }
  if (page === "workbench" && !app.replay) { app.replayFilters = formValues("#replay-filters"); loadReplay(); }
  if (page === "validation" && !app.validationLoaded) loadValidation();
}

function renderCards(data) {
  const c = data.cards, coverage = data.coverage || {};
  const deliveredCents = c.delivered_item_amount_cents;
  $("#overview-cards").innerHTML = `
    <article class="metric-card teal metric-primary"><div class="metric-label">已妥投商品记录金额<span class="unit">BRL · 不含运费</span></div><div class="metric-value amount">${money(deliveredCents)}</div><div class="metric-detail">${deliveredCents == null ? "该指标尚未由数据服务提供" : `有效金额订单 <strong>${num(c.delivered_amount_valid_orders)}</strong> 单`}</div><div class="metric-sub">全状态商品记录 ${money(c.item_amount_cents)} BRL</div></article>
    <article class="metric-card"><div class="metric-label">去重订单量<span class="unit">全部最终状态</span></div><div class="metric-value">${num(c.total_orders)}<small>单</small></div><div class="metric-detail">已妥投 <strong>${num(c.delivered_orders)}</strong> 单</div><div class="metric-sub">金额覆盖 ${pct(coverage.amount_coverage,1)} · 商品行先汇总</div></article>
    <article class="metric-card orange"><div class="metric-label">晚收货率<span class="unit">有效妥投样本</span></div><div class="metric-value">${c.late_rate == null ? `<span class="metric-no-data">无可判定样本</span>` : pct(c.late_rate)}</div><div class="metric-detail"><strong>${num(c.late_orders)}</strong> 晚到 / <strong>${num(c.late_valid_orders)}</strong> 有效订单</div><div class="metric-sub">时间有效覆盖 ${pct(coverage.late_coverage,1)} · 同日按期</div></article>
    <article class="metric-card"><div class="metric-label">低评分率<span class="unit">订单评分1—2分</span></div><div class="metric-value">${c.low_score_rate == null ? `<span class="metric-no-data">无有效评价</span>` : pct(c.low_score_rate)}</div><div class="metric-detail"><strong>${num(c.low_score_orders)}</strong> 低分 / <strong>${num(c.review_valid_orders)}</strong> 有效评价</div><div class="metric-sub">评价覆盖 ${pct(coverage.review_coverage,1)} · 非因果结论</div></article>`;
  const f = data.filters || app.overviewFilters;
  $("#overview-scope").textContent = `${f.start || "数据起始"} — ${f.end || "数据结束"} · ${num(c.total_orders)} 个匹配订单 · ${num(coverage.matched_item_rows)} 条匹配商品行`;
}

function renderMonthly(rows) {
  if (!rows.length) { $("#monthly-chart").innerHTML = empty("这一范围内没有订单", "调整下单日期或移除部分筛选条件，查看历史趋势。"); return; }
  const valid=rows.filter(row=>row.late_rate!=null);
  const peak=valid.reduce((best,row)=>!best || Number(row.late_rate)>Number(best.late_rate)?row:best,null);
  const insight=peak?`<div class="chart-insight"><strong>${esc(peak.month)} 晚收货率最高 ${pct(peak.late_rate)}</strong><span>${num(peak.late_orders)} / ${num(peak.late_valid_orders)} 有效妥投订单${Number(peak.late_valid_orders)<100?" · 小样本，谨慎比较":""}</span></div>`:"";
  $("#monthly-chart").innerHTML=`<div class="trend-grid"><div class="trend-block"><div class="trend-heading"><h3>去重订单量</h3><span>全部最终状态 · 按下单月份</span></div><div id="monthly-orders-plot" class="chart-scroll" aria-label="订单趋势图，可横向滚动"></div></div><div class="trend-block"><div class="trend-heading"><h3>晚收货率</h3><span>晚收货订单 / 有效妥投订单</span></div><div id="monthly-late-plot" class="chart-scroll" aria-label="晚收货率趋势图，可横向滚动"></div>${insight}</div></div><div class="chart-help">悬停或按 Tab 聚焦月份，读取精确数值。窄屏可在图表内横向滚动。</div>`;
  const width=Math.max(560,Math.floor($(".trend-block",$("#monthly-chart")).clientWidth || 720));
  app.chartWidth=width;
  $("#monthly-orders-plot").innerHTML=trendSVG(rows,"orders",width);
  $("#monthly-late-plot").innerHTML=valid.length?trendSVG(rows,"late",width):empty("没有有效妥投样本","当前订单无法判定晚收货结果。");
  $$(".chart-hit",$("#monthly-chart")).forEach(element=>{
    element.addEventListener("pointerenter",()=>showChartTooltip(element));
    element.addEventListener("pointerleave",hideChartTooltip);
    element.addEventListener("focus",()=>showChartTooltip(element));
    element.addEventListener("blur",hideChartTooltip);
    element.addEventListener("click",()=>showChartTooltip(element));
  });
}
function trendSVG(rows,type,width) {
  const height=210,left=58,right=18,top=16,bottom=34,plotWidth=width-left-right,plotHeight=height-top-bottom;
  const maxRaw=Math.max(...rows.map(row=>Number(type==="orders"?row.orders:row.late_rate)||0),type==="orders"?1:.05);
  const magnitude=type==="orders"?10**Math.floor(Math.log10(maxRaw)):.05;
  const max=type==="orders"?Math.ceil(maxRaw/magnitude*2)/2*magnitude:Math.max(.05,Math.ceil(maxRaw/magnitude)*magnitude);
  const step=plotWidth/rows.length,barWidth=Math.min(26,step*.6);
  let grid="",shapes="",hits="",path="",previous=null;
  const ratePeak=rows.filter(row=>row.late_rate!=null).reduce((best,row)=>!best || Number(row.late_rate)>Number(best.late_rate)?row:best,null);
  for(let index=0;index<=4;index++) {
    const y=top+plotHeight-plotHeight*index/4;
    grid+=`<line class="chart-gridline" x1="${left}" y1="${y}" x2="${width-right}" y2="${y}"/><text class="chart-axis" font-size="14" text-anchor="end" x="${left-12}" y="${y+5}">${type==="orders"?num(max*index/4):pct(max*index/4,max*.25<.01?1:0)}</text>`;
  }
  rows.forEach((row,index)=>{
    const x=left+step*(index+.5),value=type==="orders"?Number(row.orders):row.late_rate;
    const y=value==null?null:top+plotHeight-Number(value)/max*plotHeight;
    if(type==="orders") shapes+=`<rect class="chart-bar" x="${x-barWidth/2}" y="${y}" width="${barWidth}" height="${Math.max(top+plotHeight-y,1)}" rx="3"/>`;
    else if(y!=null) {
      path+=`${previous===null?"M":"L"}${x.toFixed(2)},${y.toFixed(2)} `;
      shapes+=`<circle class="chart-point ${row===ratePeak?"peak-point":""}" cx="${x}" cy="${y}" r="${row===ratePeak?5:3.5}"/>`;
    }
    previous=y;
    const stride=Math.max(1,Math.ceil(rows.length/7));
    if(index%stride===0 || index===rows.length-1) grid+=`<text class="chart-axis" font-size="14" text-anchor="middle" x="${x}" y="${height-9}">${esc(String(row.month).slice(2))}</text>`;
    const label=`${row.month}，去重订单${num(row.orders)}单，晚收货${num(row.late_orders)}除以${num(row.late_valid_orders)}有效妥投订单，晚收货率${pct(row.late_rate)}`;
    hits+=`<rect class="chart-hit" data-month-index="${index}" tabindex="0" role="img" aria-label="${esc(label)}" x="${left+step*index}" y="${top}" width="${step}" height="${plotHeight}" fill="transparent"/>`;
  });
  return `<svg class="chart-plot" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="${type==="orders"?"按下单月份的去重订单量柱形图":"按下单月份的晚收货率折线图"}"><title>${type==="orders"?"去重订单量":"晚收货率"}</title>${grid}${type==="orders"?shapes:`<path class="chart-line" d="${path}"/>${shapes}`}${hits}</svg>`;
}

function renderStates(rows) {
  const ranked = [...rows].sort((a,b) => Number(b.late_orders) - Number(a.late_orders) || Number(b.late_valid_orders) - Number(a.late_valid_orders)).slice(0,6);
  if (!ranked.length) { $("#states-chart").innerHTML = empty("没有可展示地区", "当前筛选范围没有订单记录。"); return; }
  const max = Math.max(...ranked.map(row => Number(row.late_orders)),1);
  $("#states-chart").innerHTML=`<div class="table-scroll region-table-wrap" tabindex="0" role="region" aria-label="地区异常分布表，可横向滚动查看匹配订单、晚收货与有效分母"><table class="region-table"><thead><tr><th>收货州</th><th class="numeric">匹配订单</th><th class="numeric">晚收货</th><th class="numeric">晚收货率 / 分母</th></tr></thead><tbody>${ranked.map(row=>`<tr><td><button type="button" data-state="${esc(row.state)}" aria-label="筛选收货州${esc(row.state)}">${esc(row.state)}</button></td><td class="numeric">${num(row.orders)}</td><td class="numeric"><strong>${num(row.late_orders)}</strong><svg class="region-bar" height="4" width="64" viewBox="0 0 64 4" aria-hidden="true"><rect width="64" height="4" fill="#e7ede9" rx="2"/><rect width="${Math.max(0,Number(row.late_orders)/max*64)}" height="4" fill="#a76838" rx="2"/></svg></td><td class="numeric"><strong>${pct(row.late_rate,2)}</strong><small>${num(row.late_valid_orders)} 有效妥投${Number(row.late_valid_orders)<100?" · 小样本":""}</small></td></tr>`).join("")}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看地区订单量、晚收货率与分母。</div><div class="region-definition">匹配订单包含全部最终状态；晚收货率以时间有效的已妥投订单为分母。</div>`;
}

async function loadOverview() {
  const version = ++app.overviewRequest;
  const filters = {...app.overviewFilters};
  hideChartTooltip();formBusy("#overview-filters",true);
  $("#overview-cards").innerHTML = cardSkeletons();
  loading("#monthly-chart"); loading("#states-chart");
  $("#overview-scope").textContent = "正在按所选范围核对指标…";
  const cardsPromise = request("/api/overview", filters).then(data => {
    if (version !== app.overviewRequest) return;
    app.overview = data; renderCards(data); renderMonthly(data.monthly || []); renderStates(data.states || []);
  }).catch(error => {
    if (version !== app.overviewRequest) return;
    $("#overview-cards").innerHTML = errorHTML(error,"overview");
    $("#monthly-chart").innerHTML = empty("趋势暂不可用", "重新读取数据后恢复展示。");
    $("#states-chart").innerHTML = empty("地区统计暂不可用", "重新读取数据后恢复展示。");
    $("#overview-scope").textContent = "读取失败，当前没有可确认的汇总指标";
  });
  await Promise.all([cardsPromise, loadOrders()]);
  if(version===app.overviewRequest)formBusy("#overview-filters",false);
}

function renderPagination(id, data, kind) {
  if (!data.total) { $(id).innerHTML = `<span>0 个匹配订单</span>`; return; }
  const from = (data.page-1)*data.limit+1, to = Math.min(data.page*data.limit,data.total);
  $(id).innerHTML = `<span>显示 ${num(from)}—${num(to)} / 共 ${num(data.total)} 单</span><div class="pager-controls"><button type="button" data-pager="${kind}" data-page="${data.page-1}" ${data.page<=1 ? "disabled" : ""} aria-label="上一页">‹</button><span>${num(data.page)} / ${num(data.pages)}</span><button type="button" data-pager="${kind}" data-page="${data.page+1}" ${data.page>=data.pages ? "disabled" : ""} aria-label="下一页">›</button></div>`;
}

async function loadOrders() {
  const version = ++app.ordersRequest;
  loading("#orders-table"); $("#orders-pagination").innerHTML = "";
  try {
    const data = await request("/api/orders", {...app.overviewFilters, page:app.orderPage, limit:10, late:$("#order-late-filter").value});
    if (version !== app.ordersRequest) return;
    app.orders = data;
    $("#orders-total").textContent = `${num(data.total)} 单`;
    if (!data.orders.length) $("#orders-table").innerHTML = empty("没有匹配订单", "当前履约结果或业务筛选范围没有记录，可调整条件后重试。");
    else $("#orders-table").innerHTML = `<div class="table-scroll" tabindex="0" role="region" aria-label="订单明细表，可横向滚动查看全部字段和详情操作"><table class="data-table orders-table"><thead><tr><th>订单 / 下单日期</th><th>收货州</th><th class="numeric">匹配商品金额 / BRL</th><th>商品行 / 商家数</th><th>履约结果</th><th>订单评分</th><th>最终状态</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>` + data.orders.map(row => `<tr><td><span class="order-id" title="${esc(row.order_id)}">${esc(shortId(row.order_id,10))}</span><div class="cell-sub">${esc(dateTime(row.purchase_at).slice(0,16))}</div></td><td>${esc(row.customer_state || "未知州")}</td><td class="numeric"><strong>${money(row.matched_item_amount_cents)}</strong><div class="cell-sub">运费 ${money(row.matched_freight_amount_cents)}</div></td><td>${num(row.matched_item_rows ?? row.item_count)} 条匹配 / ${num(row.item_count)} 条整单<div class="cell-sub">整单 ${num(row.seller_count)} 个商家</div></td><td>${lateBadge(row)}</td><td>${row.review_valid && row.review_score != null ? `${num(row.review_score)} <span class="cell-sub">/ 5</span>` : "无有效评价"}</td><td><span class="result-label">${esc(labels.status[row.order_status] || row.order_status)}</span></td><td><button type="button" class="detail-button" data-order="${esc(row.order_id)}" data-mode="history" aria-label="查看订单${esc(shortId(row.order_id,10))}详情">查看详情</button></td></tr>`).join("") + `</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看全部字段。</div>`;
    renderPagination("#orders-pagination", data,"orders");
  } catch(error) {
    if (version !== app.ordersRequest) return;
    $("#orders-table").innerHTML = errorHTML(error,"orders"); $("#orders-total").textContent = "";
  }
}

function hoursText(value, deadlineName) {
  if (value == null || !Number.isFinite(Number(value))) return "截止时间不可判定";
  const absolute=Math.round(Math.abs(Number(value))*10)/10,days=Math.floor(absolute/24),hours=Math.round((absolute-days*24)*10)/10;
  const duration=days?`${num(days)} 天 ${num(hours,1)} 小时`:`${num(hours,1)} 小时`;
  if (Number(value) < 0) return `已超过${deadlineName} ${duration}`;
  if (Number(value) === 0) return `${deadlineName}已到`;
  return `距${deadlineName} ${duration}`;
}
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
    $("#queue-table").innerHTML = `<div class="table-scroll" tabindex="0" role="region" aria-label="履约跟进任务表，可横向滚动查看截止、状态与详情操作"><table class="data-table queue-table"><thead><tr><th>订单 / 可见阶段</th><th>异常类型与原因</th><th>截止与逾期</th><th>跟进优先级</th><th>处理状态</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>` + data.alerts.map(task => {
      const row = task.order || {},others=(task.matched_rules || [task.primary_rule]).filter(code=>code!==task.primary_rule);
      return `<tr><td><span class="order-id" title="${esc(task.order_id)}">${esc(shortId(task.order_id,10))}</span><div class="cell-sub">${esc(labels.stage[row.stage] || "已见订单事件")}</div><div class="cell-sub">收货 ${esc(row.customer_state || "未知州")} · ${esc(categoryLabel(row.single_category))}</div></td><td><strong class="task-type ${ruleClass(task.primary_rule)}">${esc(labels.rule[task.primary_rule])}</strong><div class="task-reason">${esc(task.reason)}</div><div class="rule-inline">${esc(task.primary_rule)}${others.length?` · 同时触发 ${esc(others.join("、"))}`:""}</div></td><td>${deadlineHTML(task)}</td><td><span class="priority ${["R2","R4"].includes(task.primary_rule)?"high":""}"><i class="priority-dot" aria-hidden="true"></i>${esc(task.level)}</span><div class="cell-sub">${task.kind === "overdue_monitoring" ? "逾期后核查" : "截止前跟进"}</div></td><td>${actionBadge(task.action?.status || "pending")}<div class="cell-sub">${task.action?.updated_at ? "本地已保存" : "尚未处置"}</div></td><td><button type="button" class="detail-button" data-order="${esc(task.order_id)}" data-mode="replay" aria-label="查看订单${esc(shortId(task.order_id,10))}详情">查看详情</button></td></tr>`;
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
    <section class="panel"><div class="panel-header"><div><h2>冻结留出窗口 · 分规则结果</h2><p>提示在承诺截止前发生；逾期监控单独评价。合并规则以订单去重。</p></div>${badge(report.rule_version,"blue")}</div><div class="table-scroll" tabindex="0" role="region" aria-label="冻结留出窗口规则验证表，可横向滚动查看命中比例、覆盖率与提前量"><table class="data-table"><thead><tr><th>规则 / 评价性质</th><th class="numeric">提前提示订单</th><th class="numeric">样本内命中比例</th><th class="numeric">晚到提前覆盖</th><th class="numeric">每千样本提示量</th><th class="numeric">命中提前量中位数</th></tr></thead><tbody>${results}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看完整规则结果与各项分母。</div><div class="table-description">命中比例 = 提示后最终晚到订单 / 截止前提示订单；覆盖 = 提示后最终晚到订单 / 合格晚到订单。未最终晚到的提示不等于已经证明无效，数据没有人工判断记录。</div></section>
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
  $("#quality-content").innerHTML=`<div class="data-note-grid"><article class="note-card"><h3>一单一行的数据底座</h3><p>原始订单 ${num(rows.orders)} 条，订单事实表 ${num(data.fact_rows?.orders)} 行。商品、付款与评价分别聚合后连接，避免一单多商品、多付款导致金额膨胀。</p><p>订单—商家事实表 ${num(data.fact_rows?.order_sellers)} 行；金额只归属商家商品行，订单级评分和履约事件不能复制成商家独立结果。</p></article><article class="note-card"><h3>评价时点与选择规则</h3><p>选择订单最新有效答复：评分1—5分，回答不早于下单，调查创建日期不早于下单日期。重复订单评价 ${num(review.order_id_repeated_rows_after_first)} 条，无效答复记录 ${num(review.invalid_answer_record_rows)} 条；保留覆盖率。</p><p>答复可能发生在收货前；对“收货后答复”的敏感性分析另行复核。评分与晚收货的关联不证明延误导致低分，也不输入预警触发。</p></article></div><section class="panel"><div class="panel-header"><div><h2>原始数据质量标记</h2><p>以下为全数据的订单级标记，彼此可能重叠；不等于当前筛选订单数。</p></div>${badge(data.aggregate_reconciliation_passed?"聚合对账通过":"对账待确认",data.aggregate_reconciliation_passed?"teal":"orange")}</div><div class="table-scroll" tabindex="0" role="region" aria-label="原始数据质量标记表，可横向滚动查看订单数与处理原则"><table class="data-table"><thead><tr><th>标记项</th><th class="numeric">订单数</th><th>处理原则</th></tr></thead><tbody>${issues}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看质量标记、订单数与处理原则。</div><div class="table-description">没有商品行时保留订单、不计金额；未来或倒序时间进入质量核查；截止缺失不自动推断违约。付款记录与商品加运费存在差额，不强行改成一致。</div></section>`;
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
  (currentButton || $(".nav-link.active"))?.focus();
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

document.addEventListener("click",event=> {
  const order=event.target.closest("[data-order]");if(order){openDetail(order.dataset.order,order.dataset.mode);return;}
  const pager=event.target.closest("[data-pager]");if(pager && !pager.disabled){if(pager.dataset.pager==="orders"){app.orderPage=Number(pager.dataset.page);loadOrders();}else{app.queuePage=Number(pager.dataset.page);loadReplay();}return;}
  const state=event.target.closest("[data-state]");if(state){$("#overview-state").value=state.dataset.state;const next=formValues("#overview-filters");if(!validateOverview(next))return;app.overviewFilters=next;app.orderPage=1;loadOverview();toast(`已筛选收货州 ${state.dataset.state}`);return;}
  const section=event.target.closest("[data-section]");if(section){$$(".validation-tabs button").forEach(button=>{button.classList.toggle("active",button===section);button.setAttribute("aria-pressed",String(button===section));});$$(".validation-section").forEach(el=>{el.hidden=el.id!==section.dataset.section;});return;}
  const retry=event.target.closest("[data-retry]");if(retry){({overview:loadOverview,orders:loadOrders,replay:loadReplay,validation:loadValidation,detail:()=>app.drawer&&openDetail(app.drawer.orderId,app.drawer.mode),meta:async()=>{await loadMeta();app.overviewFilters=formValues("#overview-filters");await loadOverview();}}[retry.dataset.retry] || (()=>{}))();}
});
$("#overview-filters").addEventListener("submit",event=>{event.preventDefault();const next=formValues("#overview-filters");if(!validateOverview(next))return;app.overviewFilters=next;app.orderPage=1;loadOverview();});
$("#overview-reset").addEventListener("click",()=>{$("#overview-filters").reset();$("#overview-start").value=app.defaultStart;$("#overview-end").value=app.defaultEnd;formError("#overview-filter-error","",["#overview-start","#overview-end"]);app.overviewFilters=formValues("#overview-filters");$("#order-late-filter").value="all";app.orderPage=1;loadOverview();});
$("#order-late-filter").addEventListener("change",()=>{app.orderPage=1;loadOrders();});
$("#replay-filters").addEventListener("submit",event=>{event.preventDefault();const next=formValues("#replay-filters");if(!validateReplay(next))return;app.replayFilters=next;app.queuePage=1;loadReplay();});
$("#queue-rule-filter").addEventListener("change",()=>{app.queuePage=1;loadReplay();});
$("#queue-status-filter").addEventListener("change",()=>{app.queuePage=1;loadReplay();});
$("#validation-reload").addEventListener("click",loadValidation);
$("#reset-actions").addEventListener("click",()=>{$("#reset-error").hidden=true;$("#reset-dialog").showModal();});
$("#reset-confirm").addEventListener("click",async()=>{
  const button=$("#reset-confirm");button.disabled=true;
  try {await window.OlistAPI.resetActions();$("#reset-dialog").close();app.queuePage=1;await loadReplay();toast("当前浏览器的模拟记录已重置。");}
  catch(error){$("#reset-error").textContent=error.message;$("#reset-error").hidden=false;}
  finally{button.disabled=false;}
});
$("#drawer-close").addEventListener("click",closeDetail);$("#drawer-overlay").addEventListener("click",closeDetail);
document.addEventListener("keydown",event=> {
  if(event.key==="Escape")hideChartTooltip();
  if(!app.drawer)return;
  if(event.key==="Escape"){closeDetail();return;}
  if(event.key==="Tab") {
    const elements=$$("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']",$("#order-drawer")).filter(el=>!el.hidden&&el.offsetParent!==null);
    if(!elements.length)return;
    const first=elements[0],last=elements[elements.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
$("#overview-filters").addEventListener("invalid",event=>formError("#overview-filter-error","请选择有效的开始日期与结束日期。",[`#${event.target.id}`]),true);
$("#replay-filters").addEventListener("invalid",()=>formError("#replay-filter-error","请选择完整且早于2018-10-01的历史时点。",["#replay-as-of"]),true);
$("#overview-start").addEventListener("input",()=>formError("#overview-filter-error","",["#overview-start","#overview-end"]));
$("#overview-end").addEventListener("input",()=>formError("#overview-filter-error","",["#overview-start","#overview-end"]));
$("#replay-as-of").addEventListener("input",()=>formError("#replay-filter-error","",["#replay-as-of"]));
window.addEventListener("scroll",()=>{
  const focused=document.activeElement;
  if(focused?.classList.contains("chart-hit"))showChartTooltip(focused);else hideChartTooltip();
},true);
window.addEventListener("resize",hideChartTooltip);
window.addEventListener("hashchange",()=>setPage(location.hash.slice(1)));

async function initialize() {
  $("#overview-cards").innerHTML=cardSkeletons();
  await loadMeta();
  app.overviewFilters=formValues("#overview-filters");app.replayFilters=formValues("#replay-filters");
  setPage(location.hash.slice(1));
  await loadOverview();
  if(window.ResizeObserver) {
    new ResizeObserver(()=>{
      const block=$(".trend-block",$("#monthly-chart"));
      if(!block || !block.clientWidth || !app.overview?.monthly?.length)return;
      const width=Math.max(560,Math.floor(block.clientWidth));
      if(Math.abs(width-app.chartWidth)>3){hideChartTooltip();renderMonthly(app.overview.monthly);}
    }).observe($("#monthly-chart"));
  }
}
initialize().catch(error=>{$("#global-error").innerHTML=errorHTML(error,"meta");$("#global-error").hidden=false;});
