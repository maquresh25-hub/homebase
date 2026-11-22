// ================================================================ CALENDAR TAB
// Mac: a week grid like Apple Calendar. iPhone: a week strip with the chosen day below.
import { daysLeftText, eventChip, eventsForDay, fetchCalendar, layoutColumns, normalize } from "./calendar.js";
import { drawDay, eventBlock, isBlock } from "./draw.js";
import { state } from "./state.js";
import { tasksDue } from "./tasks.js";
import { toast } from "./toast.js";
import { scrollToNow } from "./today.js";
import { $, addDays, fmtDuration, fmtHour, fmtTime, sameDay, startOfDay, startOfWeek, ymd } from "./util.js";

const narrow = window.matchMedia("(max-width: 820px)");
const cal = {
  weekStart: startOfWeek(new Date()),
  selected: startOfDay(new Date()),
  cache: new Map(),       // weekStart ms -> events fetched for weeks outside the main range
  loadingWeeks: new Set(),
  failed: new Map(),      // weekStart ms -> when its fetch last failed
  gridHour: null,         // hour at the top of the Mac calendar, kept across redraws
  gridLive: false,        // true while the calendar on screen holds a real scroll position
  view: savedView(),      // Mac only: "week" (7 days across) or "day" (1 day across)
  anchor: null,           // Mac only: the first day showing on the left
  anchorFrac: 0,          // ...and how far past it the strip is scrolled, in days
};
function savedView() {
  try { const v = localStorage.getItem("hb-cal-view"); return v === "day" || v === "month" ? v : "week"; } catch (e) { return "week"; }
}
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
cal.anchor = cal.view === "day" ? startOfDay(new Date()) : startOfWeek(new Date());
cal.month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);   // month view: the month on screen

function setView(view, day) {
  rememberGridScroll();
  const was = cal.view;
  cal.view = view;
  if (view === "month") {
    // Open the month you were looking at
    if (was !== "month") cal.month = startOfMonth(narrow.matches ? cal.selected : addDays(cal.anchor, was === "day" ? 0 : 3));
    try { localStorage.setItem("hb-cal-view", view); } catch (e) {}
    renderCalendarTab();
    return;
  }
  if (was === "month" && !day) {
    // Back from the month: this week if it's the current month, otherwise the month's first week
    const today = new Date();
    day = sameDay(startOfMonth(today), cal.month) ? (view === "day" ? today : startOfWeek(today)) : cal.month;
    if (view === "week") day = startOfWeek(day);
  }
  if (day) cal.anchor = startOfDay(day);
  else if (view === "week") cal.anchor = startOfWeek(cal.anchor);
  else if (sameDay(startOfWeek(new Date()), startOfWeek(cal.anchor))) cal.anchor = startOfDay(new Date());   // this week: open today
  cal.anchorFrac = 0;
  cal.selected = new Date(cal.anchor);
  cal.weekStart = startOfWeek(cal.anchor);
  cal.gridLive = false;   // place the strip afresh
  try { localStorage.setItem("hb-cal-view", view); } catch (e) {}
  renderCalendarTab();
}
// Forward/back one step. Mac: glide a week (a day in the day view). iPhone: a week.
function stepCalendar(dir) {
  if (cal.view === "month") { cal.month = addMonths(cal.month, dir); renderCalendarTab(); return; }
  const sc = gridScroller();
  if (!narrow.matches && sc && cal.gridLive && grid.colW) {
    const first = Math.round(sc.scrollLeft / grid.colW);
    grid.gliding = true;   // don't re-centre the strip under a glide that's still going
    sc.scrollTo({ left: (first + dir * grid.per) * grid.colW, behavior: "smooth" });
    return;
  }
  cal.weekStart = addDays(cal.weekStart, 7 * dir);
  cal.selected = addDays(cal.selected, 7 * dir);
  renderCalendarTab();
}
const WEEK_RETRY_MS = 60 * 1000;   // a week that failed to load is retried after a minute


// Events for a week: from the main copy if it covers that week, otherwise fetched on demand
function weekEvents(weekStart) {
  const s = weekStart.getTime(), e = addDays(weekStart, 7).getTime();
  if (state.range && s >= state.range[0] && e <= state.range[1]) return { events: state.events, loading: false };
  if (cal.cache.has(s)) return { events: cal.cache.get(s), loading: false };
  if (cal.loadingWeeks.has(s)) return { events: [], loading: true };
  // After a failed load, show "Try again" rather than an empty week, and retry by itself a minute later
  const failedAt = cal.failed.get(s);
  if (failedAt && Date.now() - failedAt < WEEK_RETRY_MS) return { events: [], loading: false, failed: true };
  if (!state.calUrl) return { events: [], loading: false };
  fetchWeek(weekStart);
  return { events: [], loading: true };
}

function retryWeek() {
  cal.failed.delete(cal.weekStart.getTime());
  visibleWeeks().forEach((ws) => cal.failed.delete(ws.getTime()));
  renderCalendarTab();
}

// ---- Mac strip: which saved events cover a day, and loading the weeks in view
function inMainRange(ws) {
  return !!(state.range && ws.getTime() >= state.range[0] && addDays(ws, 7).getTime() <= state.range[1]);
}
function poolFor(day) {
  const ws = startOfWeek(day);
  return inMainRange(ws) ? state.events : (cal.cache.get(ws.getTime()) || []);
}
function visibleWeeks() {
  const sc = gridScroller();
  if (!sc || !grid.colW || !grid.base) return [];
  const first = Math.floor(sc.scrollLeft / grid.colW);
  const a = startOfWeek(addDays(grid.base, first)), b = startOfWeek(addDays(grid.base, first + grid.per));
  return a.getTime() === b.getTime() ? [a] : [a, b];
}
// Fetch the weeks on screen (and the ones either side, so scrolling on doesn't show blanks)
function loadWeeksInView() {
  if (!state.calUrl) return;
  const weeks = visibleWeeks();
  if (!weeks.length) return;
  [addDays(weeks[0], -7), ...weeks, addDays(weeks[weeks.length - 1], 7)].forEach((ws) => {
    const s = ws.getTime();
    if (inMainRange(ws) || cal.cache.has(s) || cal.loadingWeeks.has(s)) return;
    const failedAt = cal.failed.get(s);
    if (failedAt && Date.now() - failedAt < WEEK_RETRY_MS) return;
    fetchWeek(ws);
  });
}

async function fetchWeek(weekStart) {
  const s = weekStart.getTime();
  cal.loadingWeeks.add(s);
  try {
    const data = await fetchCalendar(ymd(weekStart), ymd(addDays(weekStart, 7)));
    cal.cache.set(s, normalize(data.events));
    cal.failed.delete(s);
  } catch (e) {
    console.warn("Week fetch failed:", e);
    if (!cal.failed.has(s)) toast("Couldn't load that week. Check your connection.");
    cal.failed.set(s, Date.now());   // not saved as an empty week: the screen offers "Try again"
  } finally {
    cal.loadingWeeks.delete(s);
    renderCalendarTab();
  }
}

function renderCalendarTab() {
  const connected = !!state.calUrl;
  $("cal-connect").hidden = connected && !cal.editing;
  $("cal-connect-title").textContent = connected ? "Change your calendar link" : "Connect your Google Calendar";
  $("cal-btn").textContent = connected ? "Update" : "Connect";
  $("cal-settings").hidden = !connected || cal.editing;
  $("cal-views").hidden = !connected && state.calStatus === "none";

  const ws = cal.weekStart;
  const mid = addDays(ws, 3);
  const dayView = cal.view === "day" && !narrow.matches;
  $("cal-title").textContent = dayView
    ? cal.selected.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : mid.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const monthView = cal.view === "month";
  const step = monthView ? "month" : dayView ? "day" : "week";
  $("view-day").setAttribute("aria-pressed", String(dayView));
  $("view-week").setAttribute("aria-pressed", String(!dayView && !monthView));
  $("view-month").setAttribute("aria-pressed", String(monthView));
  $("wk-prev").setAttribute("aria-label", "Previous " + step);
  $("wk-next").setAttribute("aria-label", "Next " + step);
  let status = " ";
  if (state.calStatus === "ready" && state.eventsAt) status = "Updated " + fmtTime(state.eventsAt);
  else if (state.calStatus === "loading") status = "Updating…";
  else if (state.calStatus === "error") status = "Couldn't reach your calendar";
  $("cal-status").textContent = status;
  if ($("cal-views").hidden) return;
  // Only draw the week while the Calendar tab is open (showTab draws it on opening).
  // A hidden grid can't hold a scroll position, and redrawing it every minute is wasted work.
  if ($("view-calendar").hidden) return;

  $("month-grid").hidden = !monthView;
  if (monthView) { renderMonth(); return; }
  if (!narrow.matches) { renderWeekGrid(); return; }
  const { events, loading, failed } = weekEvents(ws);
  const prev = state.events;
  state.events = events;            // drawing helpers read state.events; restore right after
  try {
    renderPhoneWeek(loading, failed);
  } finally {
    state.events = prev;
  }
}

function renderPhoneWeek(loading, failed) {
  $("month-grid").hidden = true;
  rememberGridScroll();
  cal.gridLive = false;
  $("week-grid").hidden = true;
  $("phone-week").hidden = false;
  if (!sameDay(startOfWeek(cal.selected), cal.weekStart)) {
    cal.selected = addDays(cal.weekStart, cal.selected.getDay());
  }
  const strip = $("week-strip");
  strip.textContent = "";
  for (let i = 0; i < 7; i++) {
    const d = addDays(cal.weekStart, i);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "strip-day" + (sameDay(d, new Date()) ? " is-today" : "") + (sameDay(d, cal.selected) ? " is-selected" : "");
    btn.setAttribute("aria-pressed", sameDay(d, cal.selected) ? "true" : "false");
    btn.setAttribute("aria-label", d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }));
    const dow = document.createElement("span");
    dow.textContent = d.toLocaleDateString("en-US", { weekday: "narrow" });
    const num = document.createElement("b");
    num.textContent = d.getDate();
    btn.append(dow, num);
    if (eventsForDay(d).some((e) => !e.allDay)) btn.classList.add("has-events");
    btn.addEventListener("click", () => { cal.selected = d; renderCalendarTab(); });
    strip.appendChild(btn);
  }
  $("day-title").textContent = cal.selected.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const line = drawDay($("day-timeline"), $("day-allday"), cal.selected, { loading, failed, onRetry: retryWeek, emptyText: "Nothing scheduled." });
  if (line && !cal.scrolledPhone) { scrollToNow(line); cal.scrolledPhone = true; }
}

// ---------- Mac calendar: one long strip of days, scrolled sideways like Apple Calendar ----------
// The browser does the scrolling (so it follows your fingers and glides), and each day
// snaps into place when it stops. The time column and the date row stay put.
const GUTTER = 64;        // width of the time column
const DAYS_BACK = 56;     // days kept to the left of the day in view when the strip is (re)built
const DAYS_TOTAL = 238;   // days in the strip (8 weeks back, 26 ahead)
const CHIP_ROW = 26;      // height of one all-day chip row
const grid = { els: null, base: null, colW: 0, per: 7, counts: [], raf: 0, idle: null };

function gridScroller() { return grid.els && grid.els.scroller; }
function hourHeight() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56; }
function dayIndex(date) { return Math.round((startOfDay(date).getTime() - grid.base.getTime()) / 86400000); }

// Note the day on the left and the hour at the top, so a redraw, a tab switch or a
// window resize can put the calendar back in the same place.
function rememberGridScroll() {
  const sc = gridScroller();
  if (!sc || !cal.gridLive || sc.clientHeight === 0 || !grid.colW || !grid.base) return;
  const pos = sc.scrollLeft / grid.colW;
  const first = Math.max(0, Math.min(DAYS_TOTAL - 1, Math.round(pos)));
  cal.anchor = addDays(grid.base, first);
  cal.anchorFrac = pos - first;
  cal.gridHour = sc.scrollTop / hourHeight();
}

function buildGrid(host) {
  host.textContent = "";
  const mk = (cls, parent) => { const el = document.createElement("div"); el.className = cls; if (parent) parent.appendChild(el); return el; };
  const scroller = mk("wk-scroll", host);
  const canvas = mk("wk-canvas", scroller);
  const top = mk("wk-top", canvas);
  const topIn = mk("wk-topin", top);
  const head = mk("wk-head", topIn);
  const allday = mk("wk-allday", topIn);
  mk("wk-corner", top);
  const body = mk("wk-body", canvas);
  const cols = mk("wk-cols", body);
  const gutter = mk("wk-gutter", body);
  grid.els = { scroller, canvas, head, allday, body, cols, gutter };
  scroller.addEventListener("scroll", () => {
    if (!grid.raf) grid.raf = requestAnimationFrame(() => { grid.raf = 0; syncGrid(); });
    clearTimeout(grid.idle);
    grid.idle = setTimeout(gridIdle, 200);
  }, { passive: true });
  // Window resized: the days change width, so redraw and keep the same day on the left
  let lastW = 0;
  new ResizeObserver(() => {
    const w = scroller.clientWidth;
    if (!w || w === lastW) return;
    const first = lastW === 0; lastW = w;
    if (!first && !narrow.matches && !$("view-calendar").hidden) renderCalendarTab();
  }).observe(scroller);
}

// While scrolling: keep the title and the all-day area in step with the days in view
function syncGrid() {
  const { scroller, allday, head } = grid.els;
  if (!grid.colW || !grid.base) return;
  const pos = scroller.scrollLeft / grid.colW;
  const first = Math.max(0, Math.min(DAYS_TOTAL - 1, Math.round(pos)));
  const day = addDays(grid.base, first);
  const dayView = grid.per === 1;
  $("cal-title").textContent = dayView
    ? day.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })
    : addDays(day, 3).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  // All-day area: as tall as the busiest day in view
  let rows = 0;
  for (let i = Math.max(0, Math.floor(pos)); i <= Math.min(DAYS_TOTAL - 1, Math.ceil(pos) + grid.per - 1); i++) rows = Math.max(rows, grid.counts[i] || 0);
  const h = rows ? rows * CHIP_ROW + 8 : 0;
  if (allday.style.height !== h + "px") allday.style.height = h + "px";
  allday.classList.toggle("is-empty", rows === 0);
  head.classList.toggle("is-day", dayView);
}

// Scrolling has stopped: remember where, load any weeks that just came into view,
// and redraw (which also re-centres the strip if you've gone a long way).
function gridIdle() {
  grid.gliding = false;
  if (narrow.matches || $("view-calendar").hidden || !cal.gridLive) return;
  rememberGridScroll();
  cal.weekStart = startOfWeek(cal.anchor);
  cal.selected = new Date(cal.anchor);
  const idx = dayIndex(cal.anchor);
  const pending = visibleWeeks().some((ws) => !inMainRange(ws) && !cal.cache.has(ws.getTime()));
  if (idx < 14 || idx > DAYS_TOTAL - 28 || pending || $("cal-status").dataset.grid) renderCalendarTab();
}

function renderWeekGrid() {
  $("month-grid").hidden = true;
  $("phone-week").hidden = true;
  const host = $("week-grid");
  host.hidden = false;
  rememberGridScroll();
  if (!grid.els || !host.contains(grid.els.scroller)) buildGrid(host);
  const { scroller, canvas, head, allday, body, cols, gutter } = grid.els;
  const hourPx = hourHeight();
  const per = cal.view === "day" ? 1 : 7;
  const colW = Math.max(40, (scroller.clientWidth - GUTTER) / per);
  // (Re)centre the strip around the day in view: first time, and when that day nears either end
  let idx = grid.base ? dayIndex(cal.anchor) : -1;
  let place = !cal.gridLive || colW !== grid.colW || per !== grid.per;
  // (not while an arrow-button glide is under way: moving the strip then would send the glide somewhere else)
  if ((idx < 14 || idx > DAYS_TOTAL - 28) && (!grid.gliding || idx < 1 || idx > DAYS_TOTAL - 8)) {
    grid.base = addDays(startOfDay(cal.anchor), -DAYS_BACK); idx = DAYS_BACK; place = true;
  }
  grid.colW = colW; grid.per = per;
  host.classList.toggle("is-day", per === 1);
  canvas.style.width = GUTTER + DAYS_TOTAL * colW + "px";
  body.style.height = 24 * hourPx + 16 + "px";
  const y = (h) => h * hourPx + 8;
  const left = (i) => GUTTER + i * colW + "px";

  // Time column and hour lines (the whole day, midnight to midnight)
  gutter.textContent = ""; cols.textContent = ""; head.textContent = ""; allday.textContent = "";
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement("div");
    line.className = "wk-line";
    line.style.top = y(h) + "px";
    cols.appendChild(line);
    if (h === 0 || h === 24) continue;
    const label = document.createElement("span");
    label.textContent = fmtHour(h);
    label.style.top = y(h) + "px";
    gutter.appendChild(label);
  }

  const now = new Date();
  const todayMs = startOfDay(now).getTime();
  const nowHours = now.getHours() + now.getMinutes() / 60;
  grid.counts = [];
  for (let i = 0; i < DAYS_TOTAL; i++) {
    const d = addDays(grid.base, i);
    const isToday = d.getTime() === todayMs;
    const list = eventsForDay(d, poolFor(d));

    // Date at the top: click to open that day (click again to go back to the week)
    const c = document.createElement("button");
    c.type = "button";
    c.className = "wk-day" + (isToday ? " is-today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " is-weekend" : "");
    c.style.left = left(i); c.style.width = colW + "px";
    const longDate = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    c.setAttribute("aria-label", per === 1 ? "Back to the week of " + longDate : "Open " + longDate);
    const dow = document.createElement("span");
    dow.textContent = d.toLocaleDateString("en-US", { weekday: "short" });
    const num = document.createElement("b");
    num.textContent = d.getDate();
    c.append(dow, num);
    c.addEventListener("click", () => (grid.per === 1 ? setView("week") : setView("day", d)));
    head.appendChild(c);

    // All-day items and deadlines
    const chips = [...tasksDue(d), ...list.filter((e) => e.allDay || !isBlock(e))];
    grid.counts.push(chips.length);
    if (chips.length) {
      const cell = document.createElement("div");
      cell.style.left = left(i); cell.style.width = colW + "px";
      chips.forEach((e) => cell.appendChild(eventChip(e, e.allDay ? e.title : e.title + " · " + fmtTime(e.startMs))));
      allday.appendChild(cell);
    }

    // The day's column
    const col = document.createElement("div");
    col.className = "wk-col" + (isToday ? " is-today" : "");
    col.style.left = left(i); col.style.width = colW + "px";
    const dayStart = d.getTime();
    layoutColumns(list.filter(isBlock)).forEach(({ ev, col: k, cols: n }) => {
      const s = Math.max(0, (ev.startMs - dayStart) / 3600000);
      const en = Math.min(24, (ev.endMs - dayStart) / 3600000);
      const block = eventBlock(ev, (en - s) * hourPx);
      block.style.top = y(s) + 1 + "px";
      block.style.left = "calc(" + (100 * k / n) + "% + 2px)";
      block.style.width = "calc(" + (100 / n) + "% - 4px)";
      col.appendChild(block);
    });
    if (isToday) {
      const line = document.createElement("div");
      line.className = "wk-now";
      line.style.top = y(nowHours) + "px";
      col.appendChild(line);
    }
    cols.appendChild(col);
  }
  // The current time, in red, in the time column
  const nowLabel = document.createElement("b");
  nowLabel.className = "wk-now-label";
  nowLabel.textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/, "");
  nowLabel.style.top = y(nowHours) + "px";
  gutter.appendChild(nowLabel);

  // Put the strip in place. Only when something changed: touching the scroll position
  // on every redraw would cut off a glide that's still going.
  if (place) {
    scroller.style.scrollSnapType = "none";   // exact placement first, snapping back on after
    scroller.scrollTo({ left: (idx + cal.anchorFrac) * colW, behavior: "instant" });   // "instant" also stops any glide
    if (cal.gridHour === null) {
      // First time: open with the morning in view; later in the day, keep the "now" line in view
      const shown = (scroller.clientHeight - 80) / hourPx;
      cal.gridHour = nowHours > 7.5 + shown - 1.5 ? Math.max(0, nowHours - shown / 2) : 7.5;
    }
    scroller.scrollTop = cal.gridHour * hourPx;
    scroller.style.scrollSnapType = "";
  }
  cal.gridLive = true;
  syncGrid();

  // Weeks beyond the saved range load as they come into view
  loadWeeksInView();
  const status = $("cal-status");
  const weeks = visibleWeeks().filter((ws) => !inMainRange(ws) && !cal.cache.has(ws.getTime()));
  delete status.dataset.grid;
  if (weeks.some((ws) => cal.loadingWeeks.has(ws.getTime()))) { status.textContent = "Loading…"; status.dataset.grid = "1"; }
  else if (weeks.some((ws) => cal.failed.has(ws.getTime()))) {
    status.textContent = "Couldn't load this week. ";
    status.dataset.grid = "1";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-link";
    retry.textContent = "Try again";
    retry.addEventListener("click", retryWeek);
    status.appendChild(retry);
  }
}

// ---------- Month view (Mac and iPhone) ----------
// Mac: each day lists its first few items. iPhone: each day shows coloured dots.
// Click a day to open it.
function renderMonth() {
  rememberGridScroll();
  cal.gridLive = false;
  $("week-grid").hidden = true;
  $("phone-week").hidden = true;
  const host = $("month-grid");
  host.hidden = false;
  host.textContent = "";
  if (!cal.month) cal.month = startOfMonth(new Date());
  const first = cal.month;
  const phone = narrow.matches;
  $("cal-title").textContent = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const names = document.createElement("div");
  names.className = "mo-names";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((n) => {
    const d = document.createElement("div");
    d.textContent = phone ? n[0] : n;
    names.appendChild(d);
  });
  host.appendChild(names);

  const start = startOfWeek(first);
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const rows = Math.ceil((first.getDay() + daysIn) / 7);
  const gridEl = document.createElement("div");
  gridEl.className = "mo-grid";
  gridEl.style.setProperty("--rows", rows);
  const todayMs = startOfDay(new Date()).getTime();
  const rowH = Math.max(96, (window.innerHeight - 232) / rows);
  const maxItems = Math.max(2, Math.floor((rowH - 60) / 20.5));
  let loading = false, failed = false;
  for (let w = 0; w < rows; w++) {
    const ws = addDays(start, 7 * w), s = ws.getTime();
    // Weeks outside the saved range load as the month opens
    if (!inMainRange(ws) && !cal.cache.has(s)) {
      const failedAt = cal.failed.get(s);
      if (cal.loadingWeeks.has(s)) loading = true;
      else if (failedAt && Date.now() - failedAt < WEEK_RETRY_MS) failed = true;
      else if (state.calUrl) { fetchWeek(ws); loading = true; }
    }
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "mo-day" + (d.getMonth() !== first.getMonth() ? " is-out" : "") + (d.getTime() === todayMs ? " is-today" : "");
      const list = eventsForDay(d, poolFor(d));
      const items = [...tasksDue(d), ...list.filter((e) => e.allDay || !isBlock(e)), ...list.filter(isBlock)];
      const longDate = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      cell.setAttribute("aria-label", longDate + (items.length ? ", " + items.length + (items.length === 1 ? " item" : " items") : ""));
      const num = document.createElement("b");
      num.textContent = d.getDate();
      cell.appendChild(num);
      if (phone) {
        const dots = document.createElement("span");
        dots.className = "mo-dots";
        items.slice(0, 4).forEach((e) => { const dot = document.createElement("i"); dot.className = "cat-" + e.cat; dots.appendChild(dot); });
        cell.appendChild(dots);
      } else {
        items.slice(0, maxItems).forEach((e) => {
          const row = document.createElement("span");
          row.className = "mo-ev cat-" + e.cat;
          row.textContent = (isBlock(e) ? fmtTime(e.startMs).replace(":00", "").replace(" ", "").toLowerCase() + " " : "") + e.title;
          cell.appendChild(row);
        });
        if (items.length > maxItems) {
          const more = document.createElement("span");
          more.className = "mo-more";
          more.textContent = "+" + (items.length - maxItems) + " more";
          cell.appendChild(more);
        }
      }
      cell.addEventListener("click", () => {
        if (narrow.matches) { cal.selected = d; cal.weekStart = startOfWeek(d); cal.scrolledPhone = false; }
        setView(narrow.matches ? "week" : "day", d);
      });
      gridEl.appendChild(cell);
    }
  }
  host.appendChild(gridEl);
  const status = $("cal-status");
  if (loading) status.textContent = "Loading…";
  else if (failed) {
    status.textContent = "Couldn't load part of this month. ";
    const retry = document.createElement("button");
    retry.type = "button"; retry.className = "btn-link"; retry.textContent = "Try again";
    retry.addEventListener("click", () => { cal.failed.clear(); renderCalendarTab(); });
    status.appendChild(retry);
  }
}

// ---------- Event details (opens on tap) ----------
function openEventSheet(ev) {
  const sheet = $("event-sheet");
  $("sheet-title").textContent = ev.title;
  $("sheet-dot").className = "dot cat-" + ev.cat;
  const day = new Date(ev.startMs).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("sheet-when").textContent = ev.allDay ? day + " · All day"
    : day + " · " + fmtTime(ev.startMs) + (ev.endMs > ev.startMs ? " – " + fmtTime(ev.endMs) : "");
  const now = Date.now();
  let rel = "";
  if (!ev.allDay && ev.endMs > ev.startMs) {
    rel = fmtDuration(ev.endMs - ev.startMs) + " · " +
      (now < ev.startMs ? "starts in " + fmtAway(ev.startMs - now) : now < ev.endMs ? "ends in " + fmtAway(ev.endMs - now) : "finished");
  } else if (startOfDay(new Date(ev.startMs)).getTime() >= startOfDay(new Date()).getTime()) {
    rel = daysLeftText(ev).replace(/^t/, "T").replace(/^in /, "In ");
  }
  $("sheet-rel").textContent = rel;
  $("sheet-rel").hidden = !rel;
  $("sheet-cal").textContent = ev.calendar ? "From " + ev.calendar : "";
  $("sheet-loc").textContent = ev.location || "";
  $("sheet-loc").hidden = !ev.location;
  sheet.hidden = false;
  $("sheet-close").focus();
}
function closeEventSheet() { $("event-sheet").hidden = true; }
// "20 min", "3 h 5 min", "2 days"
function fmtAway(ms) { return ms >= 36 * 3600000 ? Math.round(ms / 86400000) + " days" : fmtDuration(Math.max(60000, ms)); }

function wireCalendarTab() {
  $("wk-prev").addEventListener("click", () => stepCalendar(-1));
  $("wk-next").addEventListener("click", () => stepCalendar(1));
  $("view-day").addEventListener("click", () => setView("day"));
  $("view-week").addEventListener("click", () => setView("week"));
  $("view-month").addEventListener("click", () => setView("month"));

  // Mac keyboard: ← → move, T today, D day view, W week view
  document.addEventListener("keydown", (e) => {
    if ($("view-calendar").hidden || narrow.matches || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!$("event-sheet").hidden || !$("session-sheet").hidden || !$("stale-sheet").hidden) return;
    if (e.key === "ArrowLeft") stepCalendar(-1);
    else if (e.key === "ArrowRight") stepCalendar(1);
    else if (e.key === "t" || e.key === "T") $("wk-today").click();
    else if (e.key === "d" || e.key === "D") setView("day");
    else if (e.key === "w" || e.key === "W") setView("week");
    else if (e.key === "m" || e.key === "M") setView("month");
    else return;
    e.preventDefault();
  });
  $("wk-today").addEventListener("click", () => {
    cal.month = startOfMonth(new Date());
    cal.weekStart = startOfWeek(new Date()); cal.selected = startOfDay(new Date());
    if (cal.view === "month") { renderCalendarTab(); return; }
    cal.anchor = cal.view === "day" && !narrow.matches ? startOfDay(new Date()) : startOfWeek(new Date());
    cal.anchorFrac = 0;
    // Mac: glide back if this week is still on the strip; otherwise redraw there
    const sc = gridScroller();
    const idx = grid.base ? dayIndex(cal.anchor) : -1;
    if (!narrow.matches && sc && cal.gridLive && idx >= 14 && idx <= DAYS_TOTAL - 28) {
      grid.gliding = true;
      sc.scrollTo({ left: idx * grid.colW, behavior: "smooth" });
      return;
    }
    cal.gridLive = false;
    renderCalendarTab();
  });
  narrow.addEventListener("change", renderCalendarTab);
  $("cal-settings").addEventListener("click", () => {
    cal.editing = true; renderCalendarTab(); $("cal-url").focus();
  });
  $("sheet-close").addEventListener("click", closeEventSheet);
  const card = $("event-sheet").querySelector(".sheet");
  let dragY = null;
  card.addEventListener("touchstart", (e) => { dragY = e.touches[0].clientY; card.style.transition = "none"; }, { passive: true });
  card.addEventListener("touchmove", (e) => {
    if (dragY === null) return;
    card.style.transform = "translateY(" + Math.max(0, e.touches[0].clientY - dragY) + "px)";
  }, { passive: true });
  card.addEventListener("touchend", (e) => {
    if (dragY === null) return;
    const dy = e.changedTouches[0].clientY - dragY;
    dragY = null;
    card.style.transition = ""; card.style.transform = "";
    if (dy > 90) closeEventSheet();
  });
  $("event-sheet").addEventListener("click", (e) => { if (e.target.id === "event-sheet") closeEventSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeEventSheet(); });
  // Swipe left/right on the iPhone day view to change day
  let x0 = null;
  $("phone-week").addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $("phone-week").addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) < 60) return;
    cal.selected = addDays(cal.selected, dx < 0 ? 1 : -1);
    cal.weekStart = startOfWeek(cal.selected);
    renderCalendarTab();
  });
}

export { cal, openEventSheet, poolFor, rememberGridScroll, renderCalendarTab, wireCalendarTab };
