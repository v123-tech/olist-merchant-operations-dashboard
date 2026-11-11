/** orders: preserved V1 templates and request sequence guards, with injected services. */
export function createOrders(ctx) {
  const {$,app,request,esc,num,money,dateTime,shortId,lateBadge,labels,loading,empty,errorHTML}=ctx;

function renderPagination(id, data, kind) {
  if (!data.total) { $(id).innerHTML = `<span>0 个匹配订单</span>`; return; }
  const from = (data.page-1)*data.limit+1, to = Math.min(data.page*data.limit,data.total);
  $(id).innerHTML = `<span>显示 ${num(from)}—${num(to)} / 共 ${num(data.total)} 单</span><div class="pager-controls"><button type="button" data-pager="${kind}" data-page="${data.page-1}" ${data.page<=1 ? "disabled" : ""} aria-label="上一页">‹</button><span>${num(data.page)} / ${num(data.pages)}</span><button type="button" data-pager="${kind}" data-page="${data.page+1}" ${data.page>=data.pages ? "disabled" : ""} aria-label="下一页">›</button></div>`;
}

function renderOrdersPrompt() {
  $("#orders-total").textContent="";$("#orders-pagination").innerHTML="";
  $("#order-late-filter").disabled=true;
  $("#orders-table").innerHTML='<div class="empty-state"><strong>按需查看完整订单</strong><small id="orders-data-note">默认日期可先查看最近订单；自定义筛选与回放首次需准备约15 MB完整历史数据。</small><button type="button" class="button subtle" data-load-orders aria-describedby="orders-data-note">加载订单明细</button></div>';
}

async function loadOrders() {
  if(!app.ordersRequested){renderOrdersPrompt();return;}
  $("#order-late-filter").disabled=false;
  const version = ++app.ordersRequest;
  loading("#orders-table"); $("#orders-pagination").innerHTML = "";
  try {
    const data = await request("/api/orders", {...app.overviewFilters, page:app.orderPage, limit:10, late:$("#order-late-filter").value});
    if (version !== app.ordersRequest) return;
    app.orders = data;
    $("#orders-total").textContent = `${num(data.total)} 单`;
    if (!data.orders.length) $("#orders-table").innerHTML = empty("没有匹配订单", "当前履约结果或业务筛选范围没有记录，可调整条件后重试。");
    else $("#orders-table").innerHTML = `<div class="table-scroll" tabindex="0" role="region" aria-label="订单明细表，可横向滚动查看全部字段和详情操作"><table class="data-table orders-table"><thead><tr><th scope="col">订单 / 下单日期</th><th scope="col">收货州</th><th scope="col" class="numeric">匹配商品金额 / BRL</th><th scope="col">商品行 / 商家数</th><th scope="col">履约结果</th><th scope="col">订单评分</th><th scope="col">最终状态</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>` + data.orders.map(row => `<tr><td><span class="order-id" title="${esc(row.order_id)}">${esc(shortId(row.order_id,10))}</span><div class="cell-sub">${esc(dateTime(row.purchase_at).slice(0,16))}</div></td><td>${esc(row.customer_state || "未知州")}</td><td class="numeric"><strong>${money(row.matched_item_amount_cents)}</strong><div class="cell-sub">运费 ${money(row.matched_freight_amount_cents)}</div></td><td>${num(row.matched_item_rows ?? row.item_count)} 条匹配 / ${num(row.item_count)} 条整单<div class="cell-sub">整单 ${num(row.seller_count)} 个商家</div></td><td>${lateBadge(row)}</td><td>${row.review_valid && row.review_score != null ? `${num(row.review_score)} <span class="cell-sub">/ 5</span>` : "无有效评价"}</td><td><span class="result-label">${esc(labels.status[row.order_status] || row.order_status)}</span></td><td><button type="button" class="detail-button" data-order="${esc(row.order_id)}" data-mode="history" aria-label="查看订单${esc(shortId(row.order_id,10))}详情">查看详情</button></td></tr>`).join("") + `</tbody></table></div><div class="table-scroll-hint">窄屏可在表格内横向滚动，查看全部字段。</div>`;
    renderPagination("#orders-pagination", data,"orders");
  } catch(error) {
    if (version !== app.ordersRequest) return;
    $("#orders-table").innerHTML = errorHTML(error,"orders"); $("#orders-total").textContent = "";
  }
}

  return {renderPagination,renderOrdersPrompt,loadOrders};
}
