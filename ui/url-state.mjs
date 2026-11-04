/** Shareable UI state only. Validation never fetches data or starts a worker. */
export const URL_DEFAULTS = Object.freeze({view:"overview",start:"2017-01-01",end:"2018-06-30",seller:"",category:"",state:"",as_of:"2018-03-15T08:00"});
const VIEWS = new Set(["overview","workbench","validation"]);
const KEYS = new Set(Object.keys(URL_DEFAULTS));
const STATES = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));
const issue = (code,parameter,message) => ({code,parameter,message});
export function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(value+"T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===value;
}
export function validateFilterState(state, {cutoff="2018-10-01T00:00"}={}) {
  const errors=[];
  if(!VIEWS.has(state.view)) errors.push(issue("view","view","网址中的页面名称无效，请选择经营概览、履约工作台或规则与验证。"));
  for(const key of ["start","end"]) if(!isCalendarDate(state[key])) errors.push(issue("date",key,"网址中的下单日期无效，请使用真实的 YYYY-MM-DD 日期。"));
  if(isCalendarDate(state.start)&&isCalendarDate(state.end)&&state.start>state.end) errors.push(issue("date_order","start","开始日期不能晚于结束日期，请调整日期范围。"));
  if(state.seller&&!/^[a-f0-9]{32}$/.test(state.seller)) errors.push(issue("seller","seller","网址中的商家标识无效，请从筛选列表重新选择。"));
  if(state.category&&!/^[a-z0-9_]{1,80}$/.test(state.category)) errors.push(issue("category","category","网址中的品类无效，请从筛选列表重新选择。"));
  if(state.state&&!STATES.has(state.state)) errors.push(issue("state","state","网址中的收货州无效，请从筛选列表重新选择。"));
  const time=String(state.as_of||"");
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(time)||!isCalendarDate(time.slice(0,10))||Number(time.slice(11,13))>23||Number(time.slice(14,16))>59) errors.push(issue("as_of","as_of","网址中的回放时点无效，请选择完整的历史日期与时间。"));
  else if(time>=String(cutoff).replace(" ","T").slice(0,16)) errors.push(issue("cutoff","as_of","历史回放时点必须早于2018-10-01 00:00观察边界。"));
  return errors;
}
export function validateMetadataState(state, meta) {
  const errors=[];
  for(const [key,list,label] of [["seller",meta?.sellers,"商家"],["category",meta?.categories,"品类"],["state",meta?.states,"收货州"]]) {
    if(state[key] && !list?.some(item=>(typeof item==="string"?item:item.id)===state[key])) errors.push(issue("unknown_"+key,key,`网址中的${label}不在当前数据版本中，请从筛选列表重新选择。`));
  }
  return errors;
}
export function parseURLState(input, {defaults=URL_DEFAULTS,meta}={}) {
  const url=new URL(input,"https://shoppeek.invalid/app/"), params=url.searchParams, errors=[];
  const state={...URL_DEFAULTS,...defaults};
  for(const key of new Set(params.keys())) {
    if(!KEYS.has(key)) { errors.push(issue("unknown_parameter",key,"网址包含不支持的筛选参数，请使用页面中的筛选条件。")); continue; }
    if(params.getAll(key).length!==1) errors.push(issue("duplicate_parameter",key,"网址包含重复的筛选参数，请重新生成分享链接。"));
    state[key]=params.get(key);
  }
  errors.push(...validateFilterState(state,{cutoff:meta?.replay?.observation_cutoff}));
  const fragment=url.hash.slice(1), legacy=VIEWS.has(fragment);
  if(legacy) state.view=fragment;
  else if(fragment) state.anchor=fragment;
  if(meta) errors.push(...validateMetadataState(state,meta));
  return {valid:errors.length===0,state,errors,legacy};
}
export function canonicalURL(state, base="https://shoppeek.invalid/app/") {
  const errors=validateFilterState({...URL_DEFAULTS,...state});
  if(errors.length) throw Object.assign(new Error(errors[0].message),{code:errors[0].code});
  const url=new URL(base), params=new URLSearchParams();
  for(const key of KEYS) { const value=state[key]??URL_DEFAULTS[key]; if(value!=="") params.set(key,value); }
  url.pathname=url.pathname.replace(/\/app(?:\/index\.html)?\/?$/,"/app/");
  url.search=params.toString();url.hash=state.anchor||"";
  return url;
}
export function createURLController(host, onRestore) {
  const restore=()=>onRestore(host.location.href);
  host.addEventListener("popstate",restore);host.addEventListener("hashchange",restore);
  return {
    read:options=>parseURLState(host.location.href,options),
    write(state,{replace=false}={}) {const target=canonicalURL(state,host.location.href);if(target.href!==host.location.href)host.history[replace?"replaceState":"pushState"]({},"",target.href);return target;},
    dispose(){host.removeEventListener("popstate",restore);host.removeEventListener("hashchange",restore);}
  };
}
