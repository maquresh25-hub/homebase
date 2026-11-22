import { cal, openEventSheet, renderCalendarTab } from "./calendar-tab.js";
import { renderEventsSection, renderWeekEventsCard } from "./events.js";
import { fb } from "./firebase.js";
import { renderExamCard } from "./kits.js";
import { renderScreenTimeCard } from "./screentime.js";
import { EVENTS_CACHE, REFRESH_MS, state } from "./state.js";
import { markEventDone } from "./sync.js";
import { save, taskRef, toggleTask } from "./tasks.js";
import { toast } from "./toast.js";
import { renderSummary, renderTimeline, renderWindDown, scrollToNow } from "./today.js";
import { renderTodoPage } from "./todo.js";
import { $, addDays, fmtTime, startOfDay, startOfWeek, ymd } from "./util.js";

let drawingCalendar = false;
// ================================================================ CALENDAR
// Colours follow the Homebase Design Guide.
function categorize(ev) {
  const t = ev.title.toLowerCase();
  const cal = (ev.calendar || "").toLowerCase();
  if (/\b(study|review|prep|practice|revision)\b/.test(t)) return "study";       // yellow
  if (/\b(exam|midterm|final)\b/.test(t)) return "exam";                          // orange: real exams only
  if (/\b(quiz|assignment|homework|lab report|due)\b/.test(t)) return "due";     // grey: Canvas quizzes and deadlines
  if (cal.includes("extracurricular")) return "extra";                            // pink
  if (cal.includes("program")) return "programs";                                 // green
  if (/alim|ʿalim|qirat|qir'?at|qur'?an|hifz|tarteel|tajweed|tafsir|fiqh|hadith|arabic|jumu/.test(t) ||
      cal.includes("tarteel")) return "islamic";                                  // purple
  return "class";                                                                 // blue
}

// Canvas adds a course code like " [74358.202670]" to titles. Hide it.
function cleanTitle(t) {
  return t.replace(/\s*\[\d+(\.\d+)?\]\s*$/, "").replace(/\s+-\s+/g, " – ").trim() || t;
}


// Turn raw events from the script into ones the app can draw
function normalize(raw) {
  return (raw || []).filter((e) => e && typeof e.title === "string" && e.start).map((e) => {
    let startMs, endMs;
    if (e.allDay) {
      const [y, m, d] = e.start.split("-").map(Number);
      const [y2, m2, d2] = (e.end || e.start).split("-").map(Number);
      startMs = new Date(y, m - 1, d).getTime();
      endMs = new Date(y2, m2 - 1, d2).getTime();
      if (endMs <= startMs) endMs = startMs + 86400000;
    } else {
      startMs = Date.parse(e.start);
      endMs = Date.parse(e.end || e.start);
    }
    const ev = { id: String(e.id || e.title + e.start), title: cleanTitle(e.title).slice(0, 200), allDay: !!e.allDay,
      startMs, endMs, calendar: String(e.calendar || ""), location: String(e.location || "") };
    ev.cat = categorize(ev);
    // "Quiz"/"due" only means a deadline when it's all-day or a due-time marker.
    // A real time block like "Chemistry Recitation + Quiz" is a class.
    if (ev.cat === "due" && !ev.allDay && ev.endMs - ev.startMs >= 15 * 60000) ev.cat = "class";
    return ev;
  }).filter((e) => !isNaN(e.startMs) && !isNaN(e.endMs));
}

function eventsForDay(date, pool) {
  const s = startOfDay(date).getTime(), e = addDays(startOfDay(date), 1).getTime();
  // Hide deadlines marked done, and duplicates that come from two calendars.
  const list = (pool || state.events).filter((ev) => ev.startMs < e && ev.endMs > s && !state.doneEvents.has(ev.id));
  return dedupe(list).sort((a, b) => a.startMs - b.startMs);
}

// The same event often comes from two calendars (e.g. "Veterans Day" from Holidays
// and "Veterans Day – University Closed" from St. John's). Keep one of each.
function simpleTitle(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function dedupe(events) {
  const seen = new Map();
  events.forEach((ev) => {
    const key = (ev.allDay ? "d" : ev.startMs + "|" + ev.endMs) + "|" + simpleTitle(ev.title);
    if (!seen.has(key)) seen.set(key, ev);
  });
  const list = [...seen.values()];
  // All-day items: drop one whose title is just the start of a longer one on the same day.
  return list.filter((ev) => !(ev.allDay && list.some((o) => o !== ev && o.allDay &&
    o.startMs === ev.startMs && simpleTitle(o.title).length > simpleTitle(ev.title).length &&
    simpleTitle(o.title).startsWith(simpleTitle(ev.title) + " "))));
}
const todaysEvents = () => eventsForDay(new Date());

// Group overlapping events into columns so nothing hides behind anything else
function layoutColumns(events) {
  const sorted = [...events].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const out = [];
  let cluster = [], clusterEnd = -1, colEnds = [];
  const flush = () => { const cols = colEnds.length; cluster.forEach((c) => out.push({ ...c, cols })); cluster = []; colEnds = []; };
  sorted.forEach((ev) => {
    if (ev.startMs >= clusterEnd && cluster.length) flush();
    let col = colEnds.findIndex((end) => end <= ev.startMs);
    if (col === -1) { col = colEnds.length; colEnds.push(ev.endMs); } else colEnds[col] = ev.endMs;
    cluster.push({ ev, col });
    clusterEnd = Math.max(clusterEnd, ev.endMs);
  });
  if (cluster.length) flush();
  return out;
}

function renderAllDay(box, allDay, markers) {
  box.textContent = "";
  const items = [
    ...allDay.map((e) => ({ ev: e, text: e.title })),
    ...markers.map((e) => ({ ev: e, text: e.title + " · " + fmtTime(e.startMs) })),
  ];
  box.hidden = items.length === 0;
  items.forEach(({ ev, text }) => box.appendChild(eventChip(ev, text)));
}

// Quizzes and deadlines: tap to mark done and hide them. Everything else: tap for details.
function eventChip(ev, text) {
  const chip = document.createElement("button");
  chip.type = "button";
  const doable = ev.cat === "due" || ev.cat === "task";
  chip.className = "chip cat-" + ev.cat + (doable ? " chip-done-able" : "");
  if (ev.cat === "task") {
    chip.title = "Mark done";
    chip.setAttribute("aria-label", "Task: " + text + ". Tap to mark done");
    const check = document.createElement("span");
    check.className = "chip-check";
    check.setAttribute("aria-hidden", "true");
    chip.appendChild(check);
    chip.addEventListener("click", () => {
      toggleTask(ev.task);
      toast("Task done", "Undo", () => save(fb.updateDoc(taskRef(ev.task.id), { done: false, doneAt: null, updatedAt: Date.now() })));
    });
  } else if (doable) {
    chip.title = "Mark done";
    chip.setAttribute("aria-label", text + ". Tap to mark done");
    const check = document.createElement("span");
    check.className = "chip-check";
    check.setAttribute("aria-hidden", "true");
    chip.appendChild(check);
    chip.addEventListener("click", () => markEventDone(ev));
  } else {
    chip.addEventListener("click", () => openEventSheet(ev));
  }
  chip.appendChild(document.createTextNode(text));
  return chip;
}

function nextExam() {
  if (state.calStatus !== "ready") return null;
  const now = Date.now();
  return state.events
    .filter((e) => e.cat === "exam" && e.endMs > now)
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
}

function daysLeft(ev) {
  return Math.round((startOfDay(new Date(ev.startMs)) - startOfDay(new Date())) / 86400000);
}

function daysLeftText(ev) {
  const d = daysLeft(ev);
  return d <= 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days";
}


let scrolledToNow = false;
function renderCalendar() {
  drawingCalendar = true;
  try { drawCalendar(); } finally { drawingCalendar = false; }
}
function drawCalendar() {
  // The To-Do page lists calendar deadlines, so it follows the calendar (but never wipes a box you're typing in)
  const el = document.activeElement;
  if (!(el && el.closest && el.closest("#todo-full"))) renderTodoPage();
  renderWindDown();
  renderScreenTimeCard();
  const line = renderTimeline();
  if (state.calStatus === "ready" && !scrolledToNow) { scrollToNow(line); scrolledToNow = true; }
  renderExamCard();
  renderCalendarTab();
  renderSummary();
  // Protected-block notes depend on the calendar (first class of the day), so events follow it
  renderWeekEventsCard();
  renderEventsSection();
}

function cacheKey() { return EVENTS_CACHE + ":" + (state.user ? state.user.uid : ""); }

function loadCachedEvents() {
  try {
    const raw = JSON.parse(localStorage.getItem(cacheKey()) || "null");
    if (raw && Array.isArray(raw.events)) {
      state.events = normalize(raw.events);
      state.eventsAt = raw.at || null;
      state.range = Array.isArray(raw.range) ? raw.range : null;
      state.calStatus = "ready";
    }
  } catch (e) { /* ignore a bad cache */ }
}

// The main copy covers last week through the next 5 weeks (Today, exams and nearby weeks)
function mainRange() {
  const from = addDays(startOfWeek(new Date()), -7);
  const to = addDays(startOfDay(new Date()), 36);
  return [from, to];
}

// Give up after 20 s. Without this, one request that never answers would block every later refresh.
const FETCH_TIMEOUT_MS = 20000;
async function fetchCalendar(from, to, url) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch((url || state.calUrl) + "&from=" + from + "&to=" + to, { cache: "no-store", signal: ctrl.signal });
    const data = await res.json();
    if (!data || data.ok !== true || !Array.isArray(data.events)) throw new Error((data && data.error) || "bad response");
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchMainRange(url) {
  const [from, to] = mainRange();
  return fetchCalendar(ymd(from), ymd(to), url);
}

function applyMainData(data) {
  state.events = normalize(data.events);
  state.eventsAt = Date.now();
  // Older scripts ignore from/to and send yesterday to +30 days
  if (data.from && data.to) {
    const [fy, fm, fd] = data.from.split("-").map(Number), [ty, tm, td] = data.to.split("-").map(Number);
    state.range = [new Date(fy, fm - 1, fd).getTime(), new Date(ty, tm - 1, td).getTime()];
  } else {
    state.range = [addDays(startOfDay(new Date()), -1).getTime(), addDays(startOfDay(new Date()), 31).getTime()];
  }
  state.calStatus = "ready";
  cal.cache.clear();
  cal.failed.clear();
  try { localStorage.setItem(cacheKey(), JSON.stringify({ at: state.eventsAt, range: state.range, events: data.events })); } catch (e) {}
}

let fetching = false;
async function refreshEvents(showLoading) {
  if (!state.calUrl || fetching) return;
  fetching = true;
  if (showLoading || !state.events.length) { state.calStatus = "loading"; renderCalendar(); }
  try {
    const data = await fetchMainRange(state.calUrl);
    applyMainData(data);
  } catch (e) {
    console.warn("Calendar fetch failed:", e);
    // Keep showing the last good copy if there is one
    state.calStatus = state.events.length ? "ready" : "error";
    if (state.events.length && showLoading) toast("Couldn't refresh your calendar. Showing the last saved copy.");
  } finally {
    fetching = false;
    renderCalendar();
  }
}

function validCalUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "script.google.com" &&
      /\/exec$/.test(url.pathname) && (url.searchParams.get("key") || "").length >= 32;
  } catch (e) { return false; }
}

async function loadCalendarSettings(user) {
  state.calUrl = null; state.events = []; state.eventsAt = null; state.range = null; state.calStatus = "none";
  cal.cache.clear();
  cal.failed.clear();
  loadCachedEvents();
  renderCalendar();
  try {
    const snap = await fb.getDoc(fb.doc(fb.db, "users", user.uid, "settings", "calendar"));
    const url = snap.exists() ? snap.data().url : null;
    state.calUrl = url && validCalUrl(url) ? url : null;
  } catch (e) {
    console.warn("Couldn't read calendar settings:", e);
  }
  if (!state.calUrl) { state.calStatus = state.events.length ? "ready" : "none"; renderCalendar(); return; }
  refreshEvents(false);
}

function wireCalendar() {
  $("cal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("cal-error");
    err.textContent = "";
    const url = $("cal-url").value.trim();
    if (!validCalUrl(url)) {
      err.textContent = "That doesn't look like your Homebase link. It should start with https://script.google.com/ and end with ?key= and a long code.";
      return;
    }
    if (!fb || !state.user) { err.textContent = "Sign in first."; return; }
    const btn = $("cal-btn");
    btn.disabled = true;
    try {
      // Check the link works before saving it
      const data = await fetchMainRange(url);
      await fb.setDoc(fb.doc(fb.db, "users", state.user.uid, "settings", "calendar"), { url, updatedAt: Date.now() });
      state.calUrl = url;
      $("cal-url").value = "";
      applyMainData(data);
      cal.editing = false;
      renderCalendar();
      toast("Calendar connected.");
      location.hash = "#today";
    } catch (ex) {
      console.warn(ex);
      err.textContent = "Couldn't connect with that link. Check you copied all of it, then try again.";
    } finally {
      btn.disabled = false;
    }
  });
  // Refresh when the app comes back to the front, and every 10 minutes
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.eventsAt && Date.now() - state.eventsAt > 60000) refreshEvents(false);
  });
  setInterval(() => refreshEvents(false), REFRESH_MS);
}


export { daysLeft, daysLeftText, dedupe, drawingCalendar, eventChip, eventsForDay, fetchCalendar, layoutColumns, loadCalendarSettings, nextExam, normalize, refreshEvents, renderAllDay, renderCalendar, todaysEvents, wireCalendar };
