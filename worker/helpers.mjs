/* Shared pure query validation, original local-data time handling and math. */
export const scopeKeys = ["start","end","seller","category","state"];
export const statuses = ["pending","processing","resolved","ignored"];
export const ratio = (a,b) => b ? a / b : null;
export const cmp = (a,b) => a < b ? -1 : a > b ? 1 : 0;
export const pick = (object, fields) => Object.fromEntries(fields.map(key => [key, object[key] ?? null]));
export const error = (code,message,status=400) => {const e = new Error(message);e.code=code;e.status=status;throw e;};
export function check(query,allowed) { const extras=Object.keys(query).filter(k=>!allowed.includes(k));if(extras.length)error("unknown_parameter","存在未支持参数："+extras.sort().join(",")); }
export function id(value) { if(typeof value!=="string" || !/^[0-9a-f]{32}$/.test(value))error("invalid_order_id","订单ID必须为32位小写十六进制字符。");return value; }
export function date(value,field) { if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+"T00:00:00Z")) || new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value || value.startsWith("0000"))error("invalid_date",`${field}需要有效日期YYYY-MM-DD。`); return value; }
export function time(value) { return value == null ? null : Date.parse(String(value).replace(" ","T")+"Z"); }
export function iso(value) { return new Date(value).toISOString().slice(0,19).replace("T"," "); }
export function asOf(value,config) {
  if(typeof value!=="string" || !/^20(16|17|18)-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(value))error("invalid_as_of","观察时点需要2016—2018年数据本地时间，如2018-08-15T08:00。");
  const normalized=value.replace("T"," ")+(value.length===16?":00":"");
  const t=time(normalized);
  if(!Number.isFinite(t) || iso(t)!==normalized)error("invalid_as_of","观察时点需要2016—2018年数据本地时间，如2018-08-15T08:00。");
  if(normalized>=config.outcome_cutoff_exclusive)error("as_of_outside_boundary","观察时点必须早于配置中的回放观测边界。");return normalized;
}
export function pagination(q) { return ["page","limit"].map((key,i)=> { const value=String(q[key]??(i?25:1));if(!/^[0-9]+$/.test(value)||+value<1||+value>(i?200:1000000))error("invalid_pagination",`${key}超出有效范围。`);return +value; }); }
