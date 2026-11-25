import dashboardData from './dashboardData.json' with { type: 'json' };

const finite = value => typeof value === 'number' && Number.isFinite(value);
const nearest = (values, value, fallback) => {
  const numeric = value === '' || value == null ? NaN : Number(value);
  return finite(numeric) ? values.reduce((a, b) => Math.abs(b - numeric) < Math.abs(a - numeric) ? b : a, values[0]) : (values.includes(fallback) ? fallback : values[0]);
};
export function filterMerchants(data, tier = '', category = '') {
  return data.merchants.filter(merchant => (!tier || merchant.tier === tier) && (!category || merchant.category === category));
}
export function calculateReplay(data, days, aov) {
  const spec = data.replay;
  const selectedDays = nearest(spec.days, days, 3);
  const selectedAov = nearest(spec.aov, aov, 0);
  const cell = spec.cells.find(row => row.days === selectedDays && row.aov === selectedAov);
  if (!cell) throw new Error('缺少对应历史分布');
  return {...cell, estimatedRecoverable: cell.knownBadReviews * spec.recoveryRate, laborHours: cell.alerts * spec.minutesPerAlert / 60, recoveryRate: spec.recoveryRate, minutesPerAlert: spec.minutesPerAlert};
}

if (typeof document !== 'undefined') {
  try { initializeDashboard(dashboardData); }
  catch (error) {
    const alert = document.querySelector('#app-error');
    if (alert) { alert.hidden = false; alert.textContent = '当前页面的数据未通过完整性检查，请使用重新构建后的完整版本。'; }
    document.documentElement.dataset.ready = 'error';
  }
}

function initializeDashboard(data) {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const integer = value => finite(value) ? Math.round(value).toLocaleString('zh-CN') : '暂无样本';
  const decimal = (value, digits = 1) => finite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits: digits, minimumFractionDigits: digits}) : '暂无样本';
  const percent = value => finite(value) ? `${(value * 100).toFixed(2)}%` : '暂无有效样本';
  const money = value => finite(value) ? value >= 1_000_000 ? `${decimal(value / 1_000_000, 1)}万` : decimal(value / 100, 0) : '暂无金额';
  const fullMoney = value => finite(value) ? `${decimal(value / 100, 2)}雷亚尔` : '暂无金额';
  const tierClass = tier => ({'高危': 'high', '关注': 'watch', '稳健': 'steady', '样本不足': 'small'}[tier] || 'small');
  const tierColor = tier => ({'高危': '#bd4047', '关注': '#a96c1e', '稳健': '#257868', '样本不足': '#748093'}[tier] || '#748093');
  const tabs = ['overview', 'merchants', 'replay'];
  let state = {tab: 'overview', tier: '', category: '', days: 7, aov: 0};
  let lastDialogFocus = null;
  let activeDelay = 0;
  let categoryRows = [];
  let narrowViewport = window.innerWidth <= 540;
  const dialog = $('#merchant-dialog');
  if (data.version !== 2 || data.brand !== '瞄店' || data.merchants.length !== 30) throw new Error('数据版本不匹配');

  function readState() {
    const params = new URLSearchParams(location.hash.slice(1));
    const legacyTab = location.hash.slice(1);
    const requestedTab = params.get('tab') || (tabs.includes(legacyTab) ? legacyTab : 'overview');
    const replay = calculateReplay(data, params.has('days') ? params.get('days') : 7, params.get('aov'));
    state = {tab: tabs.includes(requestedTab) ? requestedTab : 'overview', tier: params.get('tier') || '', category: params.get('category') || '', days: replay.days, aov: replay.aov};
    if (!['', '高危', '关注', '稳健', '样本不足'].includes(state.tier)) state.tier = '';
    if (state.category && !data.merchants.some(m => m.category === state.category)) state.category = '';
  }
  function writeState(replace = false) {
    const params = new URLSearchParams({tab: state.tab});
    if (state.tier) params.set('tier', state.tier);
    if (state.category) params.set('category', state.category);
    if (state.days !== 7) params.set('days', state.days);
    if (state.aov !== 0) params.set('aov', state.aov);
    const hash = `#${params}`;
    if (location.hash === hash) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  }
  function showTab(tab, focus = false) {
    state.tab = tabs.includes(tab) ? tab : 'overview';
    for (const key of tabs) {
      $(`#panel-${key}`).hidden = state.tab !== key;
      const button = $(`#tab-${key}`);
      button.setAttribute('aria-selected', String(state.tab === key));
      button.tabIndex = state.tab === key ? 0 : -1;
    }
    if (dialog.open) dialog.close();
    if (focus) $(`#tab-${state.tab}`).focus({preventScroll: true});
    document.title = `瞄店｜${{overview: '履约与差评归因总览', merchants: '商家干预台', replay: '预警规则回放器'}[state.tab]}`;
  }
  function renderOverview() {
    const k = data.kpis;
    const cards = [
      {label: '总订单数', value: integer(k.orders), unit: '单', detail: `全部原始订单状态<br>另有<strong>${integer(data.scope.sourceItems)}</strong>条商品记录`},
      {label: '整体准时履约率', value: percent(k.otd), detail: `<strong>${integer(k.onTime)}</strong>笔按期 / <strong>${integer(k.eligible)}</strong>笔有效妥投`},
      {label: '延迟订单一至二星差评率', value: percent(k.lateLowReviewRate), detail: `<strong>${integer(k.lateLowReviews)}</strong>笔差评 / <strong>${integer(k.lateReviewed)}</strong>笔有效评价`, className: 'is-risk'},
      {label: '高危商家成交额占比', value: percent(k.highRiskGmvShare), detail: `高危商家商品记录金额<br><strong>${money(k.highRiskGmvCents)}</strong>雷亚尔`, className: 'is-brand'}
    ];
    $('#overview-kpis').innerHTML = cards.map(c => `<article class="kpi-card ${c.className || ''}"><p class="kpi-label">${c.label}</p><p class="kpi-value">${c.value}${c.unit ? `<span class="unit">${c.unit}</span>` : ''}</p><p class="kpi-detail">${c.detail}</p></article>`).join('');
    $('#data-period').textContent = `${String(data.scope.start).slice(0, 10)} 至 ${String(data.scope.end).slice(0, 10)}`;
    const bands = data.delayBands;
    const validBands = bands.filter(row => finite(row.lowReviewRate));
    activeDelay = Math.max(0, bands.findIndex(row => row === validBands.reduce((best, row) => row.lowReviewRate > (best?.lowReviewRate ?? -1) ? row : best, null)));
    const width = narrowViewport ? 360 : 600, height = narrowViewport ? 275 : 290, left = narrowViewport ? 42 : 48, right = narrowViewport ? 18 : 21, top = 22, bottom = 56;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const maxRate = Math.max(.1, Math.ceil(Math.max(0, ...validBands.map(row => row.lowReviewRate)) * 5) / 5);
    const x = index => left + index * plotWidth / Math.max(1, bands.length - 1);
    const y = value => top + plotHeight * (1 - value / maxRate);
    const grid = Array.from({length: 5}, (_, i) => { const value = maxRate * i / 4; return `<line class="chart-gridline" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text class="axis-text" x="${left - 9}" y="${y(value) + 4}" text-anchor="end">${Math.round(value * 100)}%</text>`; }).join('');
    const path = bands.map((row, index) => finite(row.lowReviewRate) ? `${index && finite(bands[index - 1].lowReviewRate) ? 'L' : 'M'} ${x(index)} ${y(row.lowReviewRate)}` : '').join(' ');
    const shortBandLabels = {'按期收货': '按期', '延迟一至二天': '1—2', '延迟三至五天': '3—5', '延迟六至十天': '6—10', '延迟十一至二十天': '11—20', '延迟二十天以上': '20以上'};
    const points = bands.map((row, index) => `<text class="axis-text" x="${x(index)}" y="${height - 27}" text-anchor="middle">${escape(shortBandLabels[row.label] || row.label)}</text>${finite(row.lowReviewRate) ? `<g class="point-group ${activeDelay === index ? 'is-selected' : ''}" role="button" tabindex="0" data-band="${index}" aria-label="${escape(row.label)}，差评率${percent(row.lowReviewRate)}，${integer(row.lowReviews)}笔差评，${integer(row.reviewed)}笔有效评价"><title>${escape(row.label)}：${percent(row.lowReviewRate)}</title><circle class="chart-point-hit" cx="${x(index)}" cy="${y(row.lowReviewRate)}" r="15"/><circle class="chart-point" cx="${x(index)}" cy="${y(row.lowReviewRate)}" r="5"/></g>` : ''}`).join('');
    $('#delay-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="配送延迟天数与一至二星差评率折线图，聚焦各数据点可读取分母">${grid}<path class="line-path" d="${path}"/>${points}<text class="axis-label" x="${width - right}" y="${height - 4}" text-anchor="end">延迟天数</text></svg>`;
    renderDelayDetail();
    const categories = [...data.categories].sort((a, b) => b.eligible - a.eligible).slice(0, 8).sort((a, b) => (b.lateRate ?? -1) - (a.lateRate ?? -1));
    categoryRows = categories;
    const maxCategoryRate = Math.max(.01, ...categories.map(row => row.lateRate || 0));
    $('#category-chart').innerHTML = categories.map((row, index) => `<button class="category-row" type="button" data-category-index="${index}" aria-label="${escape(row.name)}，延迟率${percent(row.lateRate)}，${integer(row.late)}笔延迟，${integer(row.eligible)}笔有效妥投"><span class="category-name">${escape(row.name)}</span><span class="category-track" aria-hidden="true"><span class="category-fill ${index === 0 ? 'is-high' : ''}" style="width:${(row.lateRate || 0) / maxCategoryRate * 100}%"></span></span><span class="category-value">${percent(row.lateRate)}</span></button>`).join('');
    renderCategoryDetail(categories[0]);
    $('#overview-insight').textContent = `共${integer(k.late)}笔订单晚于承诺日期收货。先比较分母与差评变化，再到商家清单核查经营暴露，避免只凭订单数量判断风险。`;
  }
  function renderDelayDetail() {
    const row = data.delayBands[activeDelay];
    if (!row) return;
    $('#delay-detail').innerHTML = `<strong>${escape(row.label)}</strong>：${percent(row.lowReviewRate)}，${integer(row.lowReviews)}笔差评 / ${integer(row.reviewed)}笔有效评价；该组${integer(row.orders)}笔订单。`;
    $$('#delay-chart [data-band]').forEach(node => node.classList.toggle('is-selected', Number(node.dataset.band) === activeDelay));
  }
  function renderCategoryDetail(row) {
    $('#category-detail').innerHTML = row ? `<strong>${escape(row.name)}</strong>：${integer(row.late)}笔延迟 / ${integer(row.eligible)}笔有效妥投。` : '当前没有可比较的品类样本。';
  }
  function renderMerchants() {
    const merchants = filterMerchants(data, state.tier, state.category);
    $('#tier-filter').value = state.tier;
    $('#category-filter').value = state.category;
    $('#merchant-results').textContent = `当前展示${integer(merchants.length)}家 / 全部${integer(data.merchants.length)}家代表商家`;
    $('#scatter-count').textContent = `${integer(merchants.length)}家可见`;
    $('#merchant-empty').hidden = merchants.length > 0;
    $('#merchant-rows').innerHTML = merchants.map(merchant => `<tr><th scope="row"><button type="button" class="merchant-name" data-merchant="${escape(merchant.id)}" aria-label="查看${escape(merchant.label)}诊断">${escape(merchant.label)}</button></th><td class="role-text">${escape(merchant.role)}</td><td class="number" title="${fullMoney(merchant.gmvCents)}">${money(merchant.gmvCents)}</td><td class="number rate-cell"><strong>${percent(merchant.lateRate)}</strong><small>${integer(merchant.late)} / ${integer(merchant.eligible)}</small></td><td><span class="tier-pill ${tierClass(merchant.tier)}">${escape(merchant.tier)}</span></td><td><button class="text-button" type="button" data-merchant="${escape(merchant.id)}" aria-label="打开${escape(merchant.label)}干预建议">诊断建议</button></td></tr>`).join('');
    if (!merchants.length) { $('#scatter-chart').innerHTML = '<div class="empty-state"><p>没有满足当前筛选条件的商家</p></div>'; return; }
    const width = narrowViewport ? 360 : 780, height = narrowViewport ? 310 : 340, left = narrowViewport ? 43 : 58, right = narrowViewport ? 17 : 26, top = 24, bottom = 52;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const xMax = Math.max(1, ...data.merchants.map(m => m.gmvCents)) * 1.08;
    const yMax = Math.min(1, Math.max(.2, Math.ceil(Math.max(...data.merchants.map(m => m.lateRate || 0)) * 10) / 10 + .05));
    const x = value => left + value / xMax * plotWidth, y = value => top + (1 - value / yMax) * plotHeight;
    const bx = x(Math.min(xMax, data.quadrants.xGmvCents)), by = y(Math.min(yMax, data.quadrants.yLateRate));
    const grid = Array.from({length: 5}, (_, i) => { const ratio = i / 4; return `<line class="chart-gridline" x1="${left}" x2="${width - right}" y1="${y(yMax * ratio)}" y2="${y(yMax * ratio)}"/><text class="axis-text" text-anchor="end" x="${left - 9}" y="${y(yMax * ratio) + 4}">${Math.round(yMax * ratio * 100)}%</text><text class="axis-text" text-anchor="middle" x="${x(xMax * ratio)}" y="${height - 29}">${decimal(xMax * ratio / 1_000_000, 0)}</text>`; }).join('');
    const labelXLeft = left + (bx - left) / 2, labelXRight = bx + (width - right - bx) / 2;
    const dots = merchants.map((merchant, index) => `<g class="scatter-target" tabindex="0" role="button" data-merchant="${escape(merchant.id)}" aria-label="${escape(merchant.label)}，${escape(merchant.tier)}，商品记录金额${fullMoney(merchant.gmvCents)}，延迟率${percent(merchant.lateRate)}"><title>${escape(merchant.label)}：${percent(merchant.lateRate)}</title><circle cx="${x(merchant.gmvCents)}" cy="${y(merchant.lateRate || 0)}" r="13" fill="transparent"/><circle class="scatter-dot" cx="${x(merchant.gmvCents)}" cy="${y(merchant.lateRate || 0)}" r="6.5" fill="${tierColor(merchant.tier)}"/></g>`).join('');
    const leftLabels = bx - left >= 84 ? `<text class="quadrant-label" x="${labelXLeft}" y="${top + 20}" text-anchor="middle">提效观察</text><text class="quadrant-label" x="${labelXLeft}" y="${height - bottom - 13}" text-anchor="middle">成长观察</text>` : '';
    $('#scatter-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="商家规模与履约超时率四象限图，点击或聚焦商家数据点查看诊断"><rect x="${bx}" y="${top}" width="${width - right - bx}" height="${Math.max(0, by - top)}" fill="#fbf1f2"/>${grid}<line class="quadrant-boundary" x1="${bx}" x2="${bx}" y1="${top}" y2="${height - bottom}"/><line class="quadrant-boundary" x1="${left}" x2="${width - right}" y1="${by}" y2="${by}"/>${leftLabels}<text class="quadrant-label high" x="${labelXRight}" y="${top + 20}" text-anchor="middle">优先干预</text><text class="quadrant-label" x="${labelXRight}" y="${height - bottom - 13}" text-anchor="middle">稳定放量</text>${dots}<text class="axis-label" x="${width - right}" y="${height - 4}" text-anchor="end">商品记录金额（万雷亚尔）</text></svg>`;
  }
  function openMerchant(id, trigger) {
    const merchant = data.merchants.find(row => row.id === id);
    if (!merchant) return;
    lastDialogFocus = trigger;
    $('#merchant-dialog-title').textContent = merchant.label;
    $('#merchant-diagnosis').innerHTML = `<div class="diagnosis-body"><div class="diagnosis-summary"><span class="tier-pill ${tierClass(merchant.tier)}">${escape(merchant.tier)}</span><span>${escape(merchant.role)}</span><span>${escape(merchant.category)}</span></div><dl class="diagnosis-stats"><div><dt>商品记录金额</dt><dd title="${fullMoney(merchant.gmvCents)}">${money(merchant.gmvCents)}<span class="unit">雷亚尔</span></dd></div><div><dt>延迟率</dt><dd>${percent(merchant.lateRate)}</dd></div><div><dt>有效妥投样本</dt><dd>${integer(merchant.eligible)}单</dd></div></dl><h3>核心痛点</h3><p class="pain-text">${escape(merchant.pain)}</p><h3>三条平台运营干预建议</h3><ol class="action-list">${merchant.actions.map(action => `<li>${escape(action)}</li>`).join('')}</ol><p class="diagnosis-boundary">诊断来自历史聚合表现，尚需核查物流、品类及订单结构。建议属于运营情景，不代表责任归因或已经取得业务改善。</p></div>`;
    dialog.showModal();
    $('#close-merchant').focus();
  }
  function renderReplay() {
    const result = calculateReplay(data, state.days, state.aov);
    state.days = result.days; state.aov = result.aov;
    $('#days-slider').value = result.days;
    $('#aov-slider').value = result.aov;
    $('#days-slider').setAttribute('aria-valuetext', `${result.days}天`);
    $('#aov-slider').setAttribute('aria-valuetext', `${result.aov}雷亚尔`);
    $('#days-value').textContent = `${result.days}天`;
    $('#aov-value').textContent = result.aov ? `${integer(result.aov)}雷亚尔` : '不限金额';
    const metrics = [
      {label: '预警命中订单数', value: integer(result.alerts), unit: '单', detail: '满足当前历史条件的订单'},
      {label: '情景预计可挽回差评', value: decimal(result.estimatedRecoverable, 1), unit: '笔', detail: `已覆盖${integer(result.knownBadReviews)}笔历史差评`, className: 'estimate'},
      {label: '运营人工排查成本', value: decimal(result.laborHours, 1), unit: '小时', detail: `按每单${integer(result.minutesPerAlert)}分钟估算`}
    ];
    $('#replay-metrics').innerHTML = metrics.map(metric => `<article class="replay-metric ${metric.className || ''}"><p class="kpi-label">${metric.label}</p><p class="kpi-value">${metric.value}<span class="unit">${metric.unit}</span></p><p class="kpi-detail">${metric.detail}</p></article>`).join('');
    $('#replay-formula').textContent = `历史差评覆盖${integer(result.knownBadReviews)}笔 × 假设挽回比例${decimal(result.recoveryRate * 100, 0)}% = 情景预计可挽回${decimal(result.estimatedRecoverable, 1)}笔。`;
    $('#replay-context').textContent = `当前预警订单中，${integer(result.observableOutcomes)}笔有效妥投且有截面后评价；全部命中订单中，${integer(result.lateOutcomes)}笔最终延迟。排查工作约相当于${decimal(result.laborHours / 8, 1)}个人日（每人日八小时）。`;
    $('#replay-method').textContent = data.replay.method;
  }

  $('#category-filter').insertAdjacentHTML('beforeend', [...new Set(data.merchants.map(m => m.category))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(name => `<option>${escape(name)}</option>`).join(''));
  $$('.tabs [data-tab]').forEach(button => {
    button.addEventListener('click', () => { showTab(button.dataset.tab); writeState(); });
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(state.tab);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      showTab(tabs[target], true); writeState();
    });
  });
  $$('[data-switch]').forEach(button => button.addEventListener('click', () => { showTab(button.dataset.switch, true); writeState(); window.scrollTo({top: 0, behavior: 'auto'}); }));
  $('#tier-filter').addEventListener('change', event => { state.tier = event.target.value; renderMerchants(); writeState(); });
  $('#category-filter').addEventListener('change', event => { state.category = event.target.value; renderMerchants(); writeState(); });
  $('#reset-filters').addEventListener('click', () => { state.tier = ''; state.category = ''; renderMerchants(); writeState(); });
  const merchantInteraction = event => {
    const target = event.target.closest('[data-merchant]');
    if (!target || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
    if (event.type === 'keydown') event.preventDefault();
    openMerchant(target.dataset.merchant, target);
  };
  $('#scatter-chart').addEventListener('click', merchantInteraction);
  $('#scatter-chart').addEventListener('keydown', merchantInteraction);
  $('#merchant-rows').addEventListener('click', merchantInteraction);
  $('#close-merchant').addEventListener('click', () => dialog.close());
  $('#category-chart').addEventListener('click', event => { const button = event.target.closest('[data-category-index]'); if (button) renderCategoryDetail(categoryRows[Number(button.dataset.categoryIndex)]); });
  dialog.addEventListener('close', () => { if (lastDialogFocus?.isConnected) lastDialogFocus.focus({preventScroll: true}); });
  $('#delay-chart').addEventListener('click', event => { const target = event.target.closest('[data-band]'); if (target) { activeDelay = Number(target.dataset.band); renderDelayDetail(); } });
  $('#delay-chart').addEventListener('keydown', event => { if (!['Enter', ' '].includes(event.key)) return; const target = event.target.closest('[data-band]'); if (target) { event.preventDefault(); activeDelay = Number(target.dataset.band); renderDelayDetail(); } });
  $('#delay-chart').addEventListener('focusin', event => { const target = event.target.closest('[data-band]'); if (target) { activeDelay = Number(target.dataset.band); renderDelayDetail(); } });
  for (const [selector, key] of [['#days-slider', 'days'], ['#aov-slider', 'aov']]) {
    $(selector).addEventListener('input', event => { state[key] = Number(event.target.value); renderReplay(); writeState(true); });
    $(selector).addEventListener('change', () => writeState());
  }
  $('#reset-replay').addEventListener('click', () => { state.days = 7; state.aov = 0; renderReplay(); writeState(); });
  function restoreFromAddress() { readState(); showTab(state.tab); renderMerchants(); renderReplay(); }
  window.addEventListener('hashchange', restoreFromAddress);
  window.addEventListener('popstate', restoreFromAddress);
  window.addEventListener('resize', () => { const nextNarrow = window.innerWidth <= 540; if (nextNarrow !== narrowViewport) { narrowViewport = nextNarrow; renderOverview(); renderMerchants(); } });
  readState(); renderOverview(); renderMerchants(); renderReplay(); showTab(state.tab); writeState(true);
  document.documentElement.dataset.readyMs = performance.now().toFixed(2);
  document.documentElement.dataset.ready = 'true';
}
