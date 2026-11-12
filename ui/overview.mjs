/** overview: preserved V1 templates and request sequence guards, with injected services. */
export function createOverview(ctx) {
  const {$,app,request,loading,empty,errorHTML,cardSkeletons,formBusy}=ctx;
  const hideChartTooltip=(...args)=>ctx.hideChartTooltip(...args);
  const renderCards=(...args)=>ctx.renderCards(...args);
  const renderMonthly=(...args)=>ctx.renderMonthly(...args);
  const renderStates=(...args)=>ctx.renderStates(...args);
  const loadOrders=(...args)=>ctx.loadOrders(...args);
  const renderOrdersPrompt=(...args)=>ctx.renderOrdersPrompt(...args);
async function loadOverview() {
  const version = ++app.overviewRequest;
  // A previous page query belongs to the old scope, even while new cards load.
  ++app.ordersRequest;
  const filters = {...app.overviewFilters};
  hideChartTooltip();formBusy("#overview-filters",true);
  $("#overview-cards").innerHTML = cardSkeletons();
  loading("#monthly-chart"); loading("#states-chart");
  $("#overview-scope").textContent = "正在按所选范围核对指标…";
  $("#orders-total").textContent="";$("#orders-pagination").innerHTML="";
  $("#order-late-filter").disabled=true;
  if(app.ordersRequested)loading("#orders-table");else $("#orders-table").innerHTML="";
  try {
    const cardsReady = await request("/api/overview", filters).then(data => {
      if (version !== app.overviewRequest) return false;
      app.overview = data; renderCards(data); renderMonthly(data.monthly || []); renderStates(data.states || []);
      return true;
    }).catch(error => {
      if (version !== app.overviewRequest) return false;
      app.overview=null;app.orders=null;
      $("#overview-cards").innerHTML = errorHTML(error,"overview");
      $("#monthly-chart").innerHTML = empty("趋势暂不可用", "重新读取数据后恢复展示。");
      $("#states-chart").innerHTML = empty("地区统计暂不可用", "重新读取数据后恢复展示。");
      $("#overview-scope").textContent = "读取失败，当前没有可确认的汇总指标";
      if(app.ordersRequested)$("#orders-table").innerHTML=errorHTML(error,"overview");else renderOrdersPrompt();
      return false;
    });
    if(!cardsReady||version!==app.overviewRequest)return;
    if(app.ordersRequested)await loadOrders();else renderOrdersPrompt();
  } finally {
    if(version===app.overviewRequest)formBusy("#overview-filters",false);
  }
}

  return {loadOverview};
}
