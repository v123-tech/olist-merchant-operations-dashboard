/** filters: preserved V1 templates and request sequence guards, with injected services. */
export function createFilters(ctx) {
  const {$,$$,app,request,esc,dateTime,shortId,categoryLabel,formError}=ctx;
  const renderSource=(...args)=>ctx.renderSource(...args);
function validateOverview(values) {
  const fields=["#overview-start","#overview-end"];
  if (!values.start || !values.end) {formError("#overview-filter-error","请选择完整的下单日期范围。",fields);return false;}
  if (values.start>values.end) {formError("#overview-filter-error","开始日期不能晚于结束日期，请调整日期范围。",fields);$("#overview-start").focus();return false;}
  formError("#overview-filter-error","",fields);return true;
}

function validateReplay(values) {
  if (!values.as_of) {formError("#replay-filter-error","请选择一个完整的历史回放时点。",["#replay-as-of"]);return false;}
  const normalized=values.as_of.replace("T"," "),cutoff=app.meta?.replay?.observation_cutoff || "2018-10-01 00:00:00";
  if(normalized>=cutoff.slice(0,normalized.length)) {formError("#replay-filter-error",`历史时点必须早于 ${dateTime(cutoff)}，这是本项目的人工观察边界。`,["#replay-as-of"]);$("#replay-as-of").focus();return false;}
  formError("#replay-filter-error","",["#replay-as-of"]);return true;
}

function selectOptions(selector, values, defaultLabel, format) {
  const select = $(selector), previous = select.value;
  select.innerHTML = `<option value="">${esc(defaultLabel)}</option>` + values.map(value => `<option value="${esc(value.id)}">${esc(format ? format(value) : value.label || value.id)}</option>`).join("");
  select.value = previous;
}

async function loadMeta() {
  try {
    app.meta = await request("/api/meta");
    const meta = app.meta;
    app.defaultStart = meta.dates?.default_analysis_start || app.defaultStart;
    app.defaultEnd = meta.dates?.default_analysis_end || app.defaultEnd;
    $("#overview-start").value = app.defaultStart;
    $("#overview-end").value = app.defaultEnd;
    for (const prefix of ["overview","replay"]) {
      selectOptions(`#${prefix}-seller`, meta.sellers || [], "全部商家", value => `${value.state || ""} · ${shortId(value.id,12)}${value.city ? " · " + value.city : ""}`);
      selectOptions(`#${prefix}-category`, meta.categories || [], "全部品类", value => categoryLabel(value.id));
      selectOptions(`#${prefix}-state`, meta.states || [], "全部州");
    }
    $("#replay-as-of").max=String(meta.replay?.observation_cutoff || "2018-10-01 00:00:00").replace(" ","T").slice(0,16);
    renderSource();
    return true;
  } catch (error) {
    app.meta=null;
    const el = $("#global-error");
    el.innerHTML = `${esc(error.message)} <button class="button subtle" data-retry="meta">重新连接</button>`;
    el.hidden = false;
    return false;
  }
}

function bindFilterDisclosure(host=window) {
  const narrow=host.matchMedia("(max-width: 760px)"), panels=$$(".filter-disclosure");
  const fit=()=>panels.forEach(panel=>{panel.open=!narrow.matches;});
  fit();narrow.addEventListener("change",fit);
  panels.forEach(panel=>panel.querySelector("form")?.addEventListener("submit",event=>{
    const form=event.currentTarget, rejected=form.querySelector('[aria-invalid="true"], .form-error:not([hidden])');
    if(narrow.matches&&form.checkValidity()&&!rejected){panel.open=false;panel.querySelector("summary").focus();}
  }));
  return ()=>narrow.removeEventListener("change",fit);
}

  return {validateOverview,validateReplay,selectOptions,loadMeta,bindFilterDisclosure};
}
