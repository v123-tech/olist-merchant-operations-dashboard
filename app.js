/** ShopPeek UI coordinator: computation and storage remain behind the data client. */
import {api} from "./modules/api-client.mjs";
import * as formatting from "./ui/formatters.mjs";
import {$,$$,createDOMHelpers} from "./ui/dom.mjs";
import {createShell} from "./ui/shell.mjs";
import {createFilters} from "./ui/filters.mjs";
import {createCharts} from "./ui/charts.mjs";
import {createOverview} from "./ui/overview.mjs";
import {createOrders} from "./ui/orders.mjs";
import {createReplay} from "./ui/replay.mjs";
import {createValidation} from "./ui/validation.mjs";
import {createOrderDetail} from "./ui/order-detail.mjs";
import {URL_DEFAULTS,parseURLState,createURLController} from "./ui/url-state.mjs";
import {createErrorReporter,installGlobalErrorHandlers} from "./ui/errors.mjs";
import {bindProgress} from "./ui/progress.mjs";
import {bindCacheControls} from "./ui/cache-controls.mjs";

const app={
  meta:null,page:"overview",overview:null,orders:null,replay:null,
  overviewFilters:{},replayFilters:{},orderPage:1,queuePage:1,
  overviewRequest:0,ordersRequest:0,replayRequest:0,detailRequest:0,
  validationRequest:0,validationLoaded:false,drawer:null,lastFocus:null,
  toastTimer:null,chartWidth:0,defaultStart:URL_DEFAULTS.start,defaultEnd:URL_DEFAULTS.end,
  ordersRequested:false,navigationRequest:0,urlState:{...URL_DEFAULTS}
};
const ctx={$,$$,app,...formatting,request:(...args)=>api.request(...args)};
Object.assign(ctx,createDOMHelpers(ctx));
for(const factory of [createShell,createFilters,createCharts,createOverview,createOrders,createReplay,createValidation,createOrderDetail])Object.assign(ctx,factory(ctx));
const {
  esc,formValues,formError,validateOverview,validateReplay,setPage,loadMeta,loadOverview,
  loadOrders,loadReplay,loadValidation,openDetail,closeDetail,hideChartTooltip,
  showChartTooltip,renderMonthly,toast,errorHTML,cardSkeletons,renderOrdersPrompt
}=ctx;
const reporter=createErrorReporter({notify:message=>{
  const element=$("#global-error");
  element.innerHTML=esc(message)+' <button class="button subtle" data-retry="page">重新读取当前页面</button>';
  element.hidden=false;
}});
installGlobalErrorHandlers(window,reporter);
bindProgress(api,$("#data-progress"));
bindCacheControls({api,button:$("#clear-data-cache"),status:$("#data-cache-note"),reload:()=>location.reload()});
const router=createURLController(window,href=>{restoreLocation(href).catch(reportFailure);});
let metaPromise;
function reportFailure(error){reporter.report(error);}
function clearGlobalError(){const el=$("#global-error");el.hidden=true;el.textContent="";}
function cancelPendingViews(){
  ++app.overviewRequest;++app.ordersRequest;++app.replayRequest;++app.validationRequest;
  if(app.drawer)closeDetail();
}
function showURLFailure(parsed){
  cancelPendingViews();
  setPage(["overview","workbench","validation"].includes(parsed.state.view)?parsed.state.view:"overview");
  const element=$("#global-error");
  element.innerHTML=parsed.errors.map(error=>'<p>'+esc(error.message)+'</p>').join("")+
    '<button type="button" class="button subtle" data-reset-url>恢复默认体验链接</button>';
  element.hidden=false;
  // Keep a clear URL error visible instead of showing old values as current results.
  $("#overview-cards").innerHTML="";$("#monthly-chart").innerHTML="";$("#states-chart").innerHTML="";
  $("#overview-scope").textContent="网址条件未通过检查，尚未查询数据";
  $("#queue-table").innerHTML="";$("#replay-summary").innerHTML="";renderOrdersPrompt();
}
async function ensureMeta(){
  if(app.meta)return true;
  if(!metaPromise)metaPromise=loadMeta().finally(()=>{metaPromise=null;});
  return metaPromise;
}
function fillForms(state){
  $("#overview-start").value=state.start;$("#overview-end").value=state.end;
  $("#replay-as-of").value=state.as_of;
  for(const prefix of ["overview","replay"])for(const key of ["seller","category","state"])$(`#${prefix}-${key}`).value=state[key];
  app.overviewFilters=formValues("#overview-filters");app.replayFilters=formValues("#replay-filters");
  formError("#overview-filter-error","",["#overview-start","#overview-end"]);
  formError("#replay-filter-error","",["#replay-as-of"]);
}
async function restoreLocation(href,{focus=false}={}){
  const version=++app.navigationRequest;
  const syntactic=parseURLState(href);
  if(!syntactic.valid){showURLFailure(syntactic);return false;}
  if(!await ensureMeta() || version!==app.navigationRequest)return false;
  const parsed=parseURLState(href,{meta:app.meta,defaults:{...URL_DEFAULTS,start:app.defaultStart,end:app.defaultEnd}});
  if(!parsed.valid){showURLFailure(parsed);return false;}
  const next=parsed.state, previous=app.urlState;
  const same=Object.keys(URL_DEFAULTS).every(key=>previous[key]===next[key]);
  // The skip link keeps normal focus behavior and never starts another query.
  if(same && next.anchor==="main" && app.initialized){$("#main").focus();return true;}
  cancelPendingViews();clearGlobalError();fillForms(next);
  app.orderPage=1;app.queuePage=1;app.urlState={...next};
  router.write(next,{replace:true});
  setPage(next.view,{focus});
  app.initialized=true;
  if(next.view==="overview")await loadOverview();
  else if(next.view==="workbench")await loadReplay();
  else if(!app.validationLoaded)await loadValidation();
  if(version!==app.navigationRequest)return false;
  if(next.anchor==="main")$("#main").focus();
  return true;
}
function commitState(state,{replace=false,focus=false}={}){
  const parsed=parseURLState(new URLSearchParams(Object.entries(state).filter(([key])=>Object.hasOwn(URL_DEFAULTS,key))).toString().replace(/^/,"?"),{meta:app.meta});
  if(!parsed.valid){showURLFailure(parsed);return Promise.resolve(false);}
  const target=router.write(parsed.state,{replace});
  return restoreLocation(target.href,{focus});
}
function navigate(view){return commitState({...app.urlState,view},{focus:true});}

document.addEventListener("click",event=>{
  const load=event.target.closest("[data-load-orders]");
  if(load){app.ordersRequested=true;loadOrders().catch(reportFailure);return;}
  const resetURL=event.target.closest("[data-reset-url]");
  if(resetURL){app.ordersRequested=false;commitState({...URL_DEFAULTS},{replace:true,focus:true}).catch(reportFailure);return;}
  const viewLink=event.target.closest('a[href="#overview"],a[href="#workbench"],a[href="#validation"],a[data-page]');
  if(viewLink){if(event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(viewLink.dataset.page||viewLink.getAttribute("href").slice(1)).catch(reportFailure);return;}
  const order=event.target.closest("[data-order]");
  if(order){openDetail(order.dataset.order,order.dataset.mode).catch(reportFailure);return;}
  const pager=event.target.closest("[data-pager]");
  if(pager&&!pager.disabled){
    if(pager.dataset.pager==="orders"){app.orderPage=Number(pager.dataset.page);loadOrders().catch(reportFailure);}
    else{app.queuePage=Number(pager.dataset.page);loadReplay().catch(reportFailure);}
    return;
  }
  const state=event.target.closest("[data-state]");
  if(state){$("#overview-state").value=state.dataset.state;commitState({...app.urlState,...formValues("#overview-filters")}).then(ok=>{if(ok)toast(`已筛选收货州 ${state.dataset.state}`);}).catch(reportFailure);return;}
  const section=event.target.closest("[data-section]");
  if(section){
    $$(".validation-tabs button").forEach(button=>{button.classList.toggle("active",button===section);button.setAttribute("aria-pressed",String(button===section));});
    $$(".validation-section").forEach(el=>{el.hidden=el.id!==section.dataset.section;});return;
  }
  const retry=event.target.closest("[data-retry]");
  if(retry){
    const handlers={overview:loadOverview,orders:loadOrders,replay:loadReplay,validation:loadValidation,detail:()=>app.drawer&&openDetail(app.drawer.orderId,app.drawer.mode),meta:()=>restoreLocation(location.href),page:()=>restoreLocation(location.href)};
    Promise.resolve((handlers[retry.dataset.retry]||(()=>{}))()).catch(reportFailure);
  }
});
$("#overview-filters").addEventListener("submit",event=>{
  event.preventDefault();const values=formValues("#overview-filters");if(!validateOverview(values))return;
  commitState({...app.urlState,...values}).catch(reportFailure);
});
$("#overview-reset").addEventListener("click",()=>{
  $("#overview-filters").reset();$("#overview-start").value=app.defaultStart;$("#overview-end").value=app.defaultEnd;
  $("#order-late-filter").value="all";app.ordersRequested=false;
  commitState({...app.urlState,...formValues("#overview-filters")}).catch(reportFailure);
});
$("#order-late-filter").addEventListener("change",()=>{app.orderPage=1;loadOrders().catch(reportFailure);});
$("#replay-filters").addEventListener("submit",event=>{
  event.preventDefault();const values=formValues("#replay-filters");if(!validateReplay(values))return;
  commitState({...app.urlState,...values}).catch(reportFailure);
});
$("#queue-rule-filter").addEventListener("change",()=>{app.queuePage=1;loadReplay().catch(reportFailure);});
$("#queue-status-filter").addEventListener("change",()=>{app.queuePage=1;loadReplay().catch(reportFailure);});
$("#validation-reload").addEventListener("click",()=>loadValidation().catch(reportFailure));
$("#reset-actions").addEventListener("click",()=>{$("#reset-error").hidden=true;$("#reset-dialog").showModal();});
$("#reset-confirm").addEventListener("click",async()=>{
  const button=$("#reset-confirm");button.disabled=true;
  try{await api.resetActions();$("#reset-dialog").close();app.queuePage=1;await loadReplay();toast("当前浏览器的模拟记录已重置。");}
  catch(error){$("#reset-error").textContent=error.message;$("#reset-error").hidden=false;}
  finally{button.disabled=false;}
});
$("#drawer-close").addEventListener("click",closeDetail);$("#drawer-overlay").addEventListener("click",closeDetail);
document.addEventListener("keydown",event=>{
  if(event.key==="Escape")hideChartTooltip();
  if(!app.drawer)return;
  if(event.key==="Escape"){closeDetail();return;}
  if(event.key==="Tab"){
    const elements=$$("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']",$("#order-drawer")).filter(el=>!el.hidden&&el.offsetParent!==null);
    if(!elements.length)return;
    const first=elements[0],last=elements[elements.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }
});
$("#overview-filters").addEventListener("invalid",event=>formError("#overview-filter-error","请选择有效的开始日期与结束日期。",[`#${event.target.id}`]),true);
$("#replay-filters").addEventListener("invalid",()=>formError("#replay-filter-error","请选择完整且早于2018-10-01的历史时点。",["#replay-as-of"]),true);
for(const id of ["overview-start","overview-end"])$("#"+id).addEventListener("input",()=>formError("#overview-filter-error","",["#overview-start","#overview-end"]));
$("#replay-as-of").addEventListener("input",()=>formError("#replay-filter-error","",["#replay-as-of"]));
ctx.bindFilterDisclosure();
window.addEventListener("scroll",()=>{
  const focused=document.activeElement;
  if(focused?.classList.contains("chart-hit"))showChartTooltip(focused);else hideChartTooltip();
},true);
window.addEventListener("resize",hideChartTooltip);
if(window.ResizeObserver)new ResizeObserver(()=>{
  const block=$(".trend-block",$("#monthly-chart"));
  if(!block||!block.clientWidth||!app.overview?.monthly?.length)return;
  const width=Math.max(560,Math.floor(block.clientWidth));
  if(Math.abs(width-app.chartWidth)>3){hideChartTooltip();renderMonthly(app.overview.monthly);}
}).observe($("#monthly-chart"));
$("#overview-cards").innerHTML=cardSkeletons();renderOrdersPrompt();
restoreLocation(location.href).catch(reportFailure);
