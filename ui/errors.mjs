/** Diagnostics are memory-only categories. Never store messages, URLs, stacks or form values. */
export function createErrorReporter({notify=()=>{},now=()=>new Date().toISOString(),limit=20}={}) {
  const entries=[];
  return {
    report(_error,{kind="runtime_error"}={}) {
      const code=kind==="unhandled_rejection"?"unhandled_rejection":"runtime_error";
      const diagnostic=Object.freeze({code,at:now()});
      entries.push(diagnostic);while(entries.length>limit)entries.shift();
      notify("页面遇到未完成的操作，请重新读取当前页面后重试。",diagnostic);
      return diagnostic;
    },
    diagnostics:()=>entries.map(item=>({...item}))
  };
}
export function installGlobalErrorHandlers(host,reporter) {
  const error=event=>reporter.report(event.error,{kind:"runtime_error"});
  const rejection=event=>reporter.report(event.reason,{kind:"unhandled_rejection"});
  host.addEventListener("error",error);host.addEventListener("unhandledrejection",rejection);
  return ()=>{host.removeEventListener("error",error);host.removeEventListener("unhandledrejection",rejection);};
}
