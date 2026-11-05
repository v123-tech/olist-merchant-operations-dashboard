/** Display only fixed phase labels and numeric byte counts from the data client. */
const labels={manifest:"正在读取数据版本…",download:"正在读取历史数据…",retry:"连接中断，正在重试当前文件…",verify:"正在核对文件完整性…",decode:"正在准备可查询的数据…",ready:"数据已准备好",error:"数据暂未准备好，可在当前区域重新读取。"};
export function progressView(event={}) {
  const phase=Object.hasOwn(labels,event.phase)?event.phase:"download";
  const total=Number.isFinite(event.total)&&event.total>0?event.total:null;
  const loaded=Number.isFinite(event.loaded)&&event.loaded>=0?Math.min(event.loaded,total??event.loaded):0;
  const amount=total?` ${(loaded/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`:"";
  const resource={'orders.json.gz':'订单','items.json.gz':'商品明细'}[event.resource];
  const hint=phase==='download'&&resource?`（${resource}，首次加载较慢，完成后可复用）`:'';
  return {phase,loaded,total,hidden:phase==="ready",text:labels[phase]+(event.fromCache?"（已缓存）":hint+amount)};
}
export function bindProgress(api,element) {
  if(!api.subscribeProgress)return ()=>{};
  return api.subscribeProgress(event=>{
    const view=progressView(event),label=element.querySelector("span"),bar=element.querySelector("progress");
    element.hidden=view.hidden;label.textContent=view.text;
    if(view.total){bar.max=view.total;bar.value=view.loaded;}else bar.removeAttribute("value");
    bar.hidden=view.phase==="error";
  });
}
