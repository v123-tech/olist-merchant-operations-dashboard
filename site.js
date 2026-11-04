/* Presentation-only interactions: mobile navigation and old homepage hash links. */
(() => {
  "use strict";
  document.documentElement.classList.add("js");

  const isHome = document.body.dataset.sitePage === "home";
  const legacyViews = new Set(["overview", "workbench", "validation"]);
  function bridgeLegacyView() {
    if (!isHome) return false;
    const view = window.location.hash.slice(1);
    if (!legacyViews.has(view)) return false;
    const target = new URL("./app/", window.location.href);
    target.search = window.location.search;
    target.searchParams.set("view",view);
    target.hash = "";
    window.location.replace(target.href);
    return true;
  }
  if (bridgeLegacyView()) return;
  window.addEventListener("hashchange", bridgeLegacyView);

  const toggle = document.querySelector("[data-menu-toggle]");
  const menu = document.querySelector("[data-site-menu]");
  if (!toggle || !menu) return;
  toggle.hidden = false;

  function setOpen(open) {
    toggle.setAttribute("aria-expanded", String(open));
    menu.dataset.open = String(open);
  }
  setOpen(false);
  toggle.addEventListener("click", () => {
    setOpen(toggle.getAttribute("aria-expanded") !== "true");
  });
  menu.addEventListener("click", event => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", event => {
    if (!menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
})();
