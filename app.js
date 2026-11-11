// Homebase app — shell version (tabs, Today header, timeline with "now" line)
(function () {
  "use strict";

  const START_HOUR = 8;   // timeline starts 8 AM
  const END_HOUR = 22;    // and ends 10 PM
  const TABS = ["today", "calendar", "todo", "study", "materials"];

  // ---------- Tabs ----------
  function showTab() {
    const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "today";
    TABS.forEach((t) => {
      document.getElementById("view-" + t).hidden = t !== tab;
      const link = document.querySelector('[data-tab="' + t + '"]');
      link.classList.toggle("active", t === tab);
      if (t === tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  }

  // ---------- Today header ----------
  function renderHeader() {
    const now = new Date();
    document.getElementById("today-title").textContent = now.toLocaleDateString("en-US", {
      weekday: "long", month: "short", day: "numeric",
    });
    // Only real numbers here. Nothing is connected yet, so we say so plainly.
    document.getElementById("today-summary").textContent = "Nothing scheduled yet";
  }

  // ---------- Timeline ----------
  function fmtHour(h) {
    const suffix = h < 12 || h === 24 ? "AM" : "PM";
    const hr = h % 12 === 0 ? 12 : h % 12;
    return hr + " " + suffix;
  }

  function renderTimeline() {
    const tl = document.getElementById("timeline");
    const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
    tl.innerHTML = "";
    for (let h = START_HOUR; h <= END_HOUR; h++) {
      const row = document.createElement("div");
      row.className = "hour";
      row.style.top = (h - START_HOUR) * hourPx + 8 + "px";
      row.innerHTML = "<span>" + fmtHour(h) + "</span>";
      tl.appendChild(row);
    }
    const empty = document.createElement("p");
    empty.className = "tl-empty";
    empty.textContent = "Your calendar isn't connected yet.";
    tl.appendChild(empty);

    const now = new Date();
    const hours = now.getHours() + now.getMinutes() / 60;
    if (hours >= START_HOUR && hours <= END_HOUR) {
      const line = document.createElement("div");
      line.className = "now";
      line.style.top = (hours - START_HOUR) * hourPx + 8 + "px";
      line.innerHTML = "<b>" + now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + "</b>";
      tl.appendChild(line);
      return line;
    }
    return null;
  }

  function scrollToNow(line) {
    if (!line) return;
    const box = line.closest(".timeline-card");
    box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 3);
  }

  // ---------- Start ----------
  window.addEventListener("hashchange", showTab);
  showTab();
  renderHeader();
  scrollToNow(renderTimeline());
  // Keep the "now" line and date current
  setInterval(() => { renderHeader(); renderTimeline(); }, 60 * 1000);

  // ---------- Offline support ----------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline mode unavailable:", e));
  }
})();
