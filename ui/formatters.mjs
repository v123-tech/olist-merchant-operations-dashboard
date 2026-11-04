export const labels = {
  status: {created:"已创建",approved:"已批准",invoiced:"已开票",processing:"处理中",shipped:"已发出",delivered:"已妥投",canceled:"已取消",unavailable:"不可用"},
  action: {pending:"待处理",processing:"处理中",resolved:"已处理",ignored:"已忽略"},
  stage: {purchased:"已下单",approved:"已批准 · 待交运",handed_to_carrier:"已交承运商 · 待收货",delivered:"已收货"},
  rule: {R1:"交运截止临近",R2:"交运截止已过",R3:"承诺收货日临近",R4:"承诺收货截止已过",SHIPPING_R1_R2:"交运提示合并 R1+R2",COMBINED_R1_R2_R3:"截止前提示合并 R1+R2+R3",R4_MONITOR_ONLY:"逾期监控 R4"},
  window: {exploration:"探索窗口",validation:"调试窗口",holdout:"冻结留出窗口"},
  waterfall: {all_window_orders:"窗口全部下单订单",final_delivered:"最终状态为已妥投",single_item_row:"仅一条商品行",timestamps_available:"关键时间字段齐全",timeline_valid:"事件先后顺序有效",shipping_deadline_valid:"交运与收货截止合理",late_valid:"晚收货结果有效",delivered_before_C:"在人工观察边界前收货"},
  quality: {no_item_records:"没有商品记录",no_payment_records:"没有付款记录",multiple_sellers:"涉及多个商家",carrier_before_approval:"交运记录早于批准",delivery_before_carrier:"收货记录早于交运",shipping_before_approval:"交运截止早于批准",shipping_after_promise:"交运截止晚于收货承诺",shipping_after_2018:"交运截止晚于2018年",delivered_status_missing_delivery_event:"已妥投却缺收货事件",invalid_review_record:"无效评价答复记录"},
  category: {unknown:"未知品类",health_beauty:"健康与美容",bed_bath_table:"床品、卫浴与餐桌",sports_leisure:"运动休闲",furniture_decor:"家具与装饰",computers_accessories:"电脑配件",housewares:"家居用品",watches_gifts:"钟表与礼品",telephony:"通信设备",auto:"汽车用品",toys:"玩具",cool_stuff:"潮流用品",garden_tools:"园艺工具",perfumery:"香水",baby:"婴儿用品",electronics:"电子设备",stationery:"文具",fashion_bags_accessories:"包袋与配饰",pet_shop:"宠物用品",office_furniture:"办公家具",consoles_games:"游戏主机",luggage_accessories:"箱包配件",musical_instruments:"乐器",home_appliances:"家用电器",food:"食品",books_general_interest:"大众图书",home_construction:"家装建材"}
};

export function esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

export function num(value, digits = 0) { return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("zh-CN", {minimumFractionDigits:digits, maximumFractionDigits:digits}); }

export function pct(value, digits = 2) { return value == null || !Number.isFinite(Number(value)) ? "—" : `${num(Number(value) * 100, digits)}%`; }

export function money(cents) { return cents == null || !Number.isFinite(Number(cents)) ? "—" : num(Number(cents) / 100, 2); }

export function dateTime(value) { return value ? String(value).replace("T", " ").slice(0, 19) : "无有效记录"; }

export function localSavedTime(value) {
  if (!value) return "尚未保存";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? dateTime(value) : parsed.toLocaleString("zh-CN", {hour12:false});
}

export function shortId(value, length = 10) { return value ? String(value).slice(0, length) + "…" : "—"; }

export function categoryLabel(value) { return labels.category[value] || value || "未知品类"; }

export function badge(text, type = "neutral") { return `<span class="badge ${esc(type)}">${esc(text)}</span>`; }

export function lateBadge(row) { return Number(row.late_valid) === 1 ? (Number(row.is_late) === 1 ? badge("晚收货","orange") : badge("按期收货","teal")) : badge("不可判定"); }

export function actionBadge(status) { return `<span class="task-status ${esc(status || "pending")}"><i aria-hidden="true"></i>${esc(labels.action[status] || "待处理")}</span>`; }

export function ruleClass(code) { return ["R2","R4"].includes(code) ? "critical" : "warning"; }

export function hoursText(value, deadlineName) {
  if (value == null || !Number.isFinite(Number(value))) return "截止时间不可判定";
  const absolute=Math.round(Math.abs(Number(value))*10)/10,days=Math.floor(absolute/24),hours=Math.round((absolute-days*24)*10)/10;
  const duration=days?`${num(days)} 天 ${num(hours,1)} 小时`:`${num(hours,1)} 小时`;
  if (Number(value) < 0) return `已超过${deadlineName} ${duration}`;
  if (Number(value) === 0) return `${deadlineName}已到`;
  return `距${deadlineName} ${duration}`;
}
