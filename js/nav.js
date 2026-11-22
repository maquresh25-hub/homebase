import { cal, rememberGridScroll, renderCalendarTab } from "./calendar-tab.js";
import { renderMissed } from "./growth.js";
import { renderJournal } from "./journal.js";
import { renderKits } from "./kits.js";
import { applyLook } from "./look.js";
import { renderSettings } from "./settings.js";
import { TABS } from "./state.js";
import { renderStudy } from "./study.js";
import { renderNow, renderSummary } from "./today.js";
import { $ } from "./util.js";


// ================================================================ SHELL
function showTab() {
  const hash = location.hash.slice(1);
  const tab = TABS.includes(hash) ? hash : "today";
  rememberGridScroll();   // before the Calendar tab is hidden, note where its week grid was scrolled to
  TABS.forEach((t) => {
    $("view-" + t).hidden = t !== tab;
    const link = document.querySelector('[data-tab="' + t + '"]');
    link.classList.toggle("active", t === tab);
    if (t === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  if (tab === "study") { renderStudy(); renderMissed(); renderKits(); }
  if (tab === "journal") renderJournal();
  if (tab === "settings") renderSettings();
  if (tab === "calendar") renderCalendarTab();
  else cal.gridLive = false;   // a hidden calendar loses its scroll position; it's put back on return
}

function renderHeader() {
  const now = new Date();
  $("today-day").textContent = now.toLocaleDateString("en-US", { weekday: "long" });
  const title = $("today-title"), day = document.createElement("i");
  title.textContent = now.toLocaleDateString("en-US", { month: "long" }) + " ";
  day.textContent = now.getDate();
  title.appendChild(day);
  renderSummary();
  applyLook();
  renderNow();
}

export { renderHeader, showTab };
