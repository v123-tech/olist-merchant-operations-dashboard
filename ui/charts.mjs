/** charts: preserved V1 templates and request sequence guards, with injected services. */
export function createCharts(ctx) {
  const {$,$$,app,esc,num,pct,money,empty}=ctx;

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
  $("#monthly-chart").innerHTML=`<div class="trend-grid"><div class="trend-block"><div class="trend-heading"><h3>去重订单量</h3><span>全部最终状态 · 按下单月份</span></div><div id="monthly-orders-plot" class="chart-scroll" tabindex="0" role="region" aria-label="订单趋势图，可横向滚动"></div></div><div class="trend-block"><div class="trend-heading"><h3>晚收货率</h3><span>晚收货订单 / 有效妥投订单</span></div><div id="monthly-late-plot" class="chart-scroll" tabindex="0" role="region" aria-label="晚收货率趋势图，可横向滚动"></div>${insight}</div></div><div class="chart-help">悬停或按 Tab 聚焦月份，读取精确数值。窄屏可在图表内横向滚动。</div>`;
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
  $("#states-chart").innerHTML=`<div class="table-scroll region-table-wrap" tabindex="0" role="region" aria-label="地区异常分布表，可横向滚动查看匹配订单、晚收货与有效分母"><table class="region-table"><thead><tr><th scope="col">收货州</th><th scope="col" class="numeric">匹配订单</th><th scope="col" class="numeric">晚收货</th><th scope="col" class="numeric">晚收货率 / 分母</th></tr></thead><tbody>${ranked.map(row=>`<tr><td><button type="button" data-state="${esc(row.state)}" aria-label="筛选收货州${esc(row.state)}">${esc(row.state)}</button></td><td class="numeric">${num(row.orders)}</td><td class="numeric"><strong>${num(row.late_orders)}</strong><svg class="region-bar" height="4" width="64" viewBox="0 0 64 4" aria-hidden="true"><rect width="64" height="4" fill="#e7ede9" rx="2"/><rect width="${Math.max(0,Number(row.late_orders)/max*64)}" height="4" fill="#a76838" rx="2"/></svg></td><td class="numeric"><strong>${pct(row.late_rate,2)}</strong><small>${num(row.late_valid_orders)} 有效妥投${Number(row.late_valid_orders)<100?" · 小样本":""}</small></td></tr>`).join("")}</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看地区订单量、晚收货率与分母。</div><div class="region-definition">匹配订单包含全部最终状态；晚收货率以时间有效的已妥投订单为分母。</div>`;
}

  return {hideChartTooltip,showChartTooltip,renderCards,renderMonthly,trendSVG,renderStates};
}
