/** DOM state primitives; values are escaped before entering templates. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
export function createDOMHelpers(ctx) {
  const {app,esc,$}=ctx;
function formValues(id) { return Object.fromEntries(new FormData($(id)).entries()); }

function loading(id, label = "正在读取数据…") { $(id).innerHTML = `<div class="loading-block" role="status"><span class="spinner" aria-hidden="true"></span>${esc(label)}</div>`; }

function empty(title, text) { return `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5zM8 9h8M8 13h5"/></svg><strong>${esc(title)}</strong><small>${esc(text)}</small></div>`; }

function errorHTML(error, retry) { return `<div class="inline-error" role="alert"><strong>暂时无法读取</strong><p>${esc(error.message || error)}</p>${retry ? `<button class="button subtle" data-retry="${esc(retry)}">重新读取</button>` : ""}</div>`; }

function toast(text) { clearTimeout(app.toastTimer); const el = $("#toast"); el.textContent = text; el.hidden = false; app.toastTimer = setTimeout(() => { el.hidden = true; }, 4500); }

function cardSkeletons() { return Array.from({length:4}, () => `<article class="metric-card" aria-hidden="true"><div class="skeleton short"></div><div class="skeleton large"></div><div class="skeleton"></div><div class="skeleton short"></div></article>`).join(""); }

function formError(id, message, fields = []) {
  const element = $(id);
  element.textContent = message || "";
  element.hidden = !message;
  if(message) { const panel=element.closest("details");if(panel)panel.open=true; }
  fields.forEach(field => { if (message) $(field).setAttribute("aria-invalid","true"); else $(field).removeAttribute("aria-invalid"); });
}

function formBusy(id, busy) {
  $(id).setAttribute("aria-busy",String(busy));
  const button=$("button[type=submit]",$(id));
  if (button) button.disabled=busy;
}
  return {formValues,loading,empty,errorHTML,toast,cardSkeletons,formError,formBusy};
}
