/** shell: preserved V1 templates and request sequence guards, with injected services. */
export function createShell(ctx) {
  const {$,$$,app}=ctx;
  const hideChartTooltip=(...args)=>ctx.hideChartTooltip(...args);
  const closeDetail=(...args)=>ctx.closeDetail(...args);
function setPage(page, {focus=false}={}) {
  if (!["overview","workbench","validation"].includes(page)) page = "overview";
  const changed=page!==app.page;
  app.page = page;
  for (const candidate of ["overview","workbench","validation"]) $(`#page-${candidate}`).hidden = candidate !== page;
  for (const link of $$(".nav-link")) {
    link.classList.toggle("active", link.dataset.page === page);
    if (link.dataset.page === page) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  $("#breadcrumb-page").textContent = {overview:"经营概览",workbench:"履约工作台",validation:"规则与验证"}[page];
  hideChartTooltip();
  if(changed) { if(app.drawer)closeDetail(); window.scrollTo({top:0,behavior:"auto"}); }
  if(focus) { const heading=$(`#page-${page} h1`);heading.setAttribute("tabindex","-1");heading.focus({preventScroll:true}); }
}

  return {setPage};
}
