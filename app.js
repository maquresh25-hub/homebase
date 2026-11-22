// Homebase app — v5: shell + sign-in + synced To-Do + Google Calendar timeline + week view + study timer
// v17: weekly goals card, missed-questions bank with spaced redos, Sunday review, study method tags
// Data lives in Firebase Firestore under users/{uid}/tasks/{taskId}.
// Each task is its own document, so a change on one device never overwrites
// other tasks, and nothing is ever hard-deleted (deleted tasks are flagged).

import * as theme from "./theme.js";
import * as vault from "./vault.js";

const FIREBASE_VERSION = "13.2.0";
const FB = "https://www.gstatic.com/firebasejs/" + FIREBASE_VERSION + "/";
const firebaseConfig = {
  apiKey: "AIzaSyAvqZ0tXJbcwSdEhqeaRjYDFG-imnw753I",
  authDomain: "homebase-daa1f.firebaseapp.com",
  projectId: "homebase-daa1f",
  storageBucket: "homebase-daa1f.firebasestorage.app",
  messagingSenderId: "109987977650",
  appId: "1:109987977650:web:21e09eeaa5e1f77710ecab",
};

const DEFAULT_START = 8;  // timeline normally runs 8 AM
const DEFAULT_END = 22;   // to 10 PM, and stretches to fit earlier or later events
const EVENTS_CACHE = "hb-events-v1";      // this device's copy of the last calendar fetch
const REFRESH_MS = 10 * 60 * 1000;        // refetch the calendar every 10 minutes
const TABS = ["today", "calendar", "todo", "study", "journal", "settings"];
const MAX_TITLE = 200;
const TODAY_LIMIT = 6;  // tasks shown on the Today card

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const state = {
  status: "loading",  // loading | ready | error
  user: null,
  tasks: [],          // non-deleted tasks
  showCompleted: false,
  calUrl: null,       // private calendar link (stored in Firestore, never in the code)
  calStatus: "none",  // none | loading | ready | error
  events: [],         // events from Google Calendar
  eventsAt: null,     // when they were fetched
  doneEvents: new Set(), // calendar deadlines marked done (synced in Firestore)
  doneList: [],          // the same deadlines with titles, for the "Done deadlines" list
  showDoneDeadlines: false,
  kitLinks: {},          // exam name -> link to its exam kit (synced in settings/kits)
  courses: [],           // subjects for tagging tasks (synced in settings/courses)
  courseColors: {},      // subject name -> its colour
  lists: [],             // to-do lists (synced in settings/lists)
  kits: [],              // exam kits shown in Study (synced in settings/kits)
  range: null,        // [startMs, endMs] the main copy covers
  screenTime: {},     // { "YYYY-MM-DD": { total: minutes, apps: ["App: Xm", ...] } }
};
let fb = null;        // loaded Firebase functions + instances
let unsubscribeTasks = null;

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

// Every number shown must be real and match the screen.
function renderSummary() {
  let taskText = "\u00a0";
  if (state.status === "ready") {
    const open = openTasks().length;
    const today = doneToday();
    if (open > 0) taskText = open + " open" + (today ? " · " + today + " done today" : "");
    else taskText = state.tasks.length ? "Nothing left to do" + (today ? " · " + today + " done today" : "") : "No tasks yet";
  }
  $("todo-summary").textContent = taskText;

  const parts = [];
  if (state.calStatus === "ready") {
    const n = todaysEvents().filter(isBlock).length; // same blocks as the timeline
    parts.push(n === 0 ? "Nothing on the calendar" : n + (n === 1 ? " event" : " events"));
  }
  if (state.status === "ready") parts.push(taskText);
  const exam = nextExam();
  if (exam) parts.push(exam.title + " " + daysLeftText(exam));
  // Shown as pills; the separators stay in the text for screen readers and copy-paste
  const host = $("today-summary");
  host.textContent = parts.length ? "" : "\u00a0";
  parts.forEach((text, i) => {
    if (i) { const sep = document.createElement("span"); sep.className = "sep"; sep.textContent = " · "; host.appendChild(sep); }
    const pill = document.createElement("span");
    pill.className = "pill" + (exam && i === parts.length - 1 ? " is-key" : "");
    pill.textContent = text;
    host.appendChild(pill);
  });
}

function fmtHour(h) {
  const suffix = h < 12 || h === 24 ? "AM" : "PM";
  return (h % 12 === 0 ? 12 : h % 12) + " " + suffix;
}

// Draws one day: hour lines, coloured event blocks, all-day chips and the "now" line.
// Used by the Today screen and by the Calendar tab's iPhone day view.
function drawDay(tl, alldayBox, date, opts) {
  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
  const dayEvents = eventsForDay(date);
  const timed = dayEvents.filter(isBlock);
  const markers = dayEvents.filter((e) => !e.allDay && !isBlock(e)); // e.g. Canvas due times
  renderAllDay(alldayBox, [...dayEvents.filter((e) => e.allDay), ...tasksDue(date)], markers);

  // Stretch the timeline to fit early or late events
  const dayStart = startOfDay(date).getTime();
  const [startH, endH] = hourRange(timed, dayStart);
  const y = (hours) => (hours - startH) * hourPx + 8;

  tl.textContent = "";
  tl.style.height = (endH - startH) * hourPx + 16 + "px";
  for (let h = startH; h <= endH; h++) {
    const row = document.createElement("div");
    row.className = "hour";
    row.style.top = y(h) + "px";
    const label = document.createElement("span");
    label.textContent = h === 24 ? "12 AM" : fmtHour(h);
    row.appendChild(label);
    tl.appendChild(row);
  }

  const emptyMsg = (text, linkText, onClick, href) => {
    const p = document.createElement("p");
    p.className = "tl-empty";
    p.textContent = text;
    if (linkText) {
      const a = document.createElement(href ? "a" : "button");
      if (href) a.href = href; else { a.type = "button"; a.className = "btn-link"; a.addEventListener("click", onClick); }
      a.textContent = linkText;
      p.appendChild(a);
    }
    tl.appendChild(p);
  };
  if (opts.failed) emptyMsg("Couldn't load this week. ", "Try again", opts.onRetry);
  else if (state.calStatus === "error" && !timed.length) emptyMsg("Couldn't reach your calendar. ", "Try again", () => refreshEvents(true));
  else if (state.calStatus === "none") emptyMsg("Your calendar isn't connected yet. ", "Connect it", null, "#calendar");
  else if (opts.loading) emptyMsg("Loading…");
  else if (state.calStatus === "ready" && timed.length === 0) emptyMsg(opts.emptyText || "Nothing scheduled.");

  layoutColumns(timed).forEach(({ ev, col, cols }) => {
    const s = Math.max(startH, (ev.startMs - dayStart) / 3600000);
    const en = Math.min(endH, (ev.endMs - dayStart) / 3600000);
    const block = eventBlock(ev, (en - s) * hourPx);
    block.style.top = y(s) + 1 + "px";
    block.style.left = "calc(76px + (100% - 76px) * " + col / cols + ")";
    block.style.width = "calc((100% - 76px) / " + cols + " - 4px)";
    tl.appendChild(block);
  });

  const now = new Date();
  if (startOfDay(now).getTime() !== dayStart) return null;
  const hours = now.getHours() + now.getMinutes() / 60;
  if (hours < startH || hours > endH) return null;
  const line = document.createElement("div");
  line.className = "now";
  line.style.top = y(hours) + "px";
  const b = document.createElement("b");
  b.textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  line.appendChild(b);
  tl.appendChild(line);
  return line;
}

const isBlock = (e) => !e.allDay && e.endMs - e.startMs >= 15 * 60000;

function hourRange(timed, dayStart) {
  let startH = DEFAULT_START, endH = DEFAULT_END;
  timed.forEach((e) => {
    startH = Math.min(startH, Math.floor(Math.max(0, (e.startMs - dayStart) / 3600000)));
    endH = Math.max(endH, Math.ceil(Math.min(24, (e.endMs - dayStart) / 3600000)));
  });
  return [startH, endH];
}

// A tappable coloured block; tapping opens the event's details
function eventBlock(ev, heightPx) {
  const block = document.createElement("button");
  block.type = "button";
  block.className = "event cat-" + ev.cat;
  block.style.height = Math.max(22, heightPx - 3) + "px";
  const title = document.createElement("strong");
  title.textContent = ev.title;
  const time = document.createElement("span");
  time.textContent = fmtTime(ev.startMs) + " – " + fmtTime(ev.endMs);
  block.append(title, time);
  block.setAttribute("aria-label", ev.title + ", " + time.textContent);
  if (heightPx < 40) block.classList.add("short");
  block.addEventListener("click", () => openEventSheet(ev));
  // Finished blocks fade back; the one happening now stands out
  const nowMs = Date.now();
  if (ev.endMs <= nowMs) block.classList.add("is-past");
  else if (ev.startMs <= nowMs) block.classList.add("is-now");
  if (!hasTimer(ev)) return block;

  // Study and hifz blocks get a play button (no separate study button anywhere else)
  const logged = loggedFor(ev);
  if (logged >= 60000) {
    const em = document.createElement("em");
    em.className = "logged";
    em.textContent = "✓ " + fmtDuration(logged) + " logged";
    block.appendChild(em);
  }
  const wrap = document.createElement("div");
  wrap.className = "event-wrap cat-" + ev.cat;
  wrap.style.height = block.style.height;
  block.style.height = "";
  const isRunning = !!(timer.running && timer.running.eventId === ev.id);
  const play = document.createElement("button");
  play.type = "button";
  play.className = "play" + (isRunning ? " is-running" : "");
  play.setAttribute("aria-label", (isRunning ? "Stop study timer for " : "Start study timer for ") + ev.title);
  play.innerHTML = isRunning
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg>';
  play.addEventListener("click", (e) => { e.stopPropagation(); if (isRunning) stopSession(); else startSession(ev); });
  if (heightPx < 40) wrap.classList.add("short");
  wrap.append(block, play);
  if (!isHifz(ev)) return wrap;

  // Hifz is ticked off inside its block (it never appears as a to-do)
  const key = hifzKey(ev);
  const ticked = state.doneEvents.has(key);
  const tick = document.createElement("button");
  tick.type = "button";
  tick.className = "tick";
  tick.setAttribute("aria-pressed", String(ticked));
  tick.setAttribute("aria-label", (ticked ? "Mark not done: " : "Mark done: ") + ev.title);
  tick.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!ticked) playTick();
    setEventDone({ id: key, title: ev.title }, !ticked);
  });
  wrap.classList.add("has-tick");
  if (ticked) wrap.classList.add("is-ticked");
  wrap.appendChild(tick);
  return wrap;
}

// Blocks that can be timed: study blocks, and hifz / memorisation blocks
const HIFZ_WORDS = /hifz|hifdh|ḥifẓ|memori[sz]/i;
function isHifz(ev) { return ev.cat === "islamic" && HIFZ_WORDS.test(ev.title); }
function hasTimer(ev) { return ev.cat === "study" || isHifz(ev); }
// One tick per day, even if the block repeats daily
function hifzKey(ev) { return "hifz:" + ev.id + ":" + ymd(new Date(ev.startMs)); }

// Today shows the day as a list (the hour grid lives in the Calendar tab)
function renderTimeline() {
  drawAgenda($("timeline"), $("allday"), new Date());
  applyLook();
  renderNow();
  return null;
}

function drawAgenda(tl, alldayBox, date) {
  const dayEvents = eventsForDay(date);
  const timed = dayEvents.filter(isBlock).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const markers = dayEvents.filter((e) => !e.allDay && !isBlock(e)); // e.g. Canvas due times
  renderAllDay(alldayBox, [...dayEvents.filter((e) => e.allDay), ...tasksDue(date)], markers);
  tl.textContent = "";
  tl.className = "timeline agenda";
  tl.style.height = "";
  const note = (text, linkText, onClick, href) => {
    const p = document.createElement("p");
    p.className = "tl-empty";
    p.textContent = text;
    if (linkText) {
      const a = document.createElement(href ? "a" : "button");
      if (href) a.href = href; else { a.type = "button"; a.className = "btn-link"; a.addEventListener("click", onClick); }
      a.textContent = linkText;
      p.appendChild(a);
    }
    tl.appendChild(p);
  };
  if (state.calStatus === "error" && !timed.length) note("Couldn't reach your calendar. ", "Try again", () => refreshEvents(true));
  else if (state.calStatus === "none") note("Your calendar isn't connected yet. ", "Connect it", null, "#calendar");
  else if (state.calStatus === "ready" && timed.length === 0) note("Nothing scheduled today. Enjoy the open time.");

  const nowMs = Date.now();
  let lastEnd = null;
  timed.forEach((ev) => {
    if (lastEnd !== null && ev.startMs - lastEnd >= 30 * 60000) {
      const gap = document.createElement("div");
      gap.className = "ag-free";
      gap.textContent = fmtDuration(ev.startMs - lastEnd) + " free";
      tl.appendChild(gap);
    }
    lastEnd = Math.max(lastEnd || 0, ev.endMs);
    const row = document.createElement("div");
    row.className = "ag-row" + (ev.endMs <= nowMs ? " is-past" : ev.startMs <= nowMs ? " is-now" : "");
    const time = document.createElement("span");
    time.className = "ag-time";
    time.textContent = fmtTime(ev.startMs);
    time.setAttribute("aria-hidden", "true");
    const block = eventBlock(ev, 60);
    block.style.height = "";
    block.querySelectorAll(".event").forEach((b) => { b.style.height = ""; });
    row.append(time, block);
    if (row.classList.contains("is-now")) {
      const tag = document.createElement("span");
      tag.className = "ag-now";
      tag.textContent = "Now";
      row.appendChild(tag);
    }
    tl.appendChild(row);
  });
}

// ---------- The "Now" area at the top of Today ----------
// "SJU — Biology" reads better as "Biology" in large type
function heroTitle(t) { const m = t.match(/^\S{2,6}\s+[—–-]\s+(.+)$/); return m ? m[1] : t; }
function ringSvg(fraction, big, small, label) {
  const R = 56, C = 2 * Math.PI * R, f = Math.max(0, Math.min(1, fraction));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 148 148");
  svg.setAttribute("class", "now-ring");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.innerHTML = '<circle class="ring-track" cx="74" cy="74" r="56"></circle>' +
    '<circle class="ring-arc" cx="74" cy="74" r="56" stroke-dasharray="' + (C * f).toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 74 74)"></circle>' +
    '<text class="ring-big" x="74" y="75" text-anchor="middle"></text><text class="ring-small" x="74" y="99" text-anchor="middle"></text>';
  svg.querySelector(".ring-big").textContent = big;
  svg.querySelector(".ring-small").textContent = small;
  return svg;
}
function renderNow() {
  const host = $("now");
  if (!host) return;
  host.textContent = "";
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  if (state.calStatus !== "ready" && !state.events.length) {
    host.appendChild(el("p", "now-empty", state.calStatus === "none" ? "Connect your calendar to see what's on now." : state.calStatus === "error" ? "Couldn't reach your calendar." : "Loading your day…"));
    return;
  }
  const now = Date.now();
  const blocks = todaysEvents().filter(isBlock).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const current = blocks.filter((e) => e.startMs <= now && e.endMs > now).pop() || null;
  const next = blocks.find((e) => e.startMs > now) || null;
  const main = el("div", "now-main"), body = el("div", "now-body"), tagRow = el("div", "now-tagrow");

  let until = null, from = null, word = "left";
  if (current) { until = current.endMs; from = current.startMs; }
  else if (next) {
    until = next.startMs; word = "free";
    from = Math.max(startOfDay(new Date()).getTime(), ...blocks.filter((e) => e.endMs <= now).map((e) => e.endMs));
  }
  if (until !== null) {
    const mins = Math.max(1, Math.ceil((until - now) / 60000));
    const big = mins < 100 ? String(mins) : String(Math.round(mins / 6) / 10);
    const unit = mins < 100 ? "MIN " : "HOURS ";
    main.appendChild(ringSvg((now - from) / Math.max(1, until - from), big, unit + word.toUpperCase(), fmtDuration(until - now) + " " + word));
  }
  tagRow.appendChild(el("span", "now-tag", current ? "Now" : next ? "Free" : "Done"));
  if (current) tagRow.appendChild(el("span", "now-when", fmtTime(current.startMs) + " to " + fmtTime(current.endMs)));
  else if (next) tagRow.appendChild(el("span", "now-when", "Until " + fmtTime(next.startMs)));
  if (look.subject) tagRow.appendChild(el("span", "now-when now-subject", look.subject));
  body.appendChild(tagRow);
  if (current) {
    const title = el("button", "now-title", heroTitle(current.title));
    title.type = "button";
    title.setAttribute("aria-label", current.title + ". Open details");
    title.addEventListener("click", () => openEventSheet(current));
    body.appendChild(title);
  } else body.appendChild(el("h2", "now-title", next ? "Free time" : blocks.length ? "Nothing else today" : "Nothing scheduled today"));
  if (!current) {
    // A free gap: offer a few things from the Ideas list that fit it
    const gap = next ? Math.round((next.startMs - now) / 60000) : 240;
    const fits = openIdeas().filter((t) => (t.mins || 30) <= gap);
    if (fits.length) {
      const day = Math.floor(now / 86400000), box = el("div", "now-ideas");
      box.appendChild(el("span", "now-when", "Ideas for this gap"));
      for (let i = 0; i < Math.min(3, fits.length); i++) box.appendChild(el("a", "", fits[(day + i) % fits.length].title));
      box.querySelectorAll("a").forEach((a) => { a.href = "#todo"; a.addEventListener("click", () => { setPref("todo-list", IDEAS); renderTodoPage(); }); });
      body.appendChild(box);
    }
  }
  main.appendChild(body);
  if (next) {
    const up = el("div", "now-next");
    up.append(el("span", "now-when", "Up next"), el("b", "", heroTitle(next.title)), el("small", "", fmtTime(next.startMs) + ", in " + fmtDuration(next.startMs - now)));
    main.appendChild(up);
  }
  host.appendChild(main);
  if (blocks.length > 1) {
    const strip = el("div", "strip");
    strip.setAttribute("role", "img");
    const done = blocks.filter((e) => e.endMs <= now).length;
    strip.setAttribute("aria-label", "Today's blocks: " + done + " done, " + (blocks.length - done) + " to go");
    blocks.slice(0, 8).forEach((e) => {
      const d = el("div", e.endMs <= now ? "is-past" : e.startMs <= now ? "is-now" : "", fmtTime(e.startMs).replace(/ (AM|PM)$/, ""));
      d.style.setProperty("--w", Math.max(20, Math.round((e.endMs - e.startMs) / 60000)));
      strip.appendChild(d);
    });
    host.appendChild(strip);
  }
}

function scrollToNow(line) {
  if (!line) return;
  const box = line.closest(".timeline-card");
  box.scrollTop = Math.max(0, line.offsetTop - box.clientHeight / 3);
}

// ================================================================ TOAST
let toastTimer = null;
function toast(message, actionLabel, action) {
  const el = $("toast");
  el.textContent = "";
  const span = document.createElement("span");
  span.textContent = message;
  el.appendChild(span);
  if (actionLabel) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = actionLabel;
    btn.addEventListener("click", () => { el.hidden = true; action(); });
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ================================================================ SOUND
// A short, soft two-note chime made in code (no sound file to download).
let audioCtx = null;
function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  return audioCtx;
}
// iPhone only allows sound after a tap, and pauses ("interrupts") it whenever
// the app goes to the background. Wake it on every tap so it's ready in time.
function unlockAudio() {
  const ctx = getAudio();
  if (!ctx) return;
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  if (!ctx._unlocked) {
    // Playing a silent blip inside a tap is what fully unlocks sound on iOS.
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
    ctx._unlocked = true;
  }
}
document.addEventListener("pointerdown", unlockAudio, { passive: true });
document.addEventListener("touchend", unlockAudio, { passive: true });

function scheduleChime(ctx) {
  const t = ctx.currentTime + 0.01;
  [[880, 0], [1318.5, 0.07]].forEach(([freq, delay]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.25);
  });
}

function playTick() {
  try {
    const ctx = getAudio();
    if (!ctx) return;
    // Wait until sound is actually on before playing, or iPhone drops the notes.
    if (ctx.state === "running") scheduleChime(ctx);
    else ctx.resume().then(() => scheduleChime(ctx)).catch(() => {});
  } catch (e) { /* sound is a nice-to-have; never block a tick */ }
}

// ================================================================ TASKS (data)
const PRIORITIES = ["normal", "high", "low"];   // tapping the flag steps through these
const priRank = (t) => (t.priority === "high" ? 0 : t.priority === "low" ? 2 : 1);
// ---- To-do lists. A list is where a task lives (School, Personal); a subject is what it is about.
const IDEAS = "ideas";   // things to do in free time: kept out of Today's list and the task counts
const DEFAULT_LISTS = [{ id: "school", name: "School" }, { id: "personal", name: "Personal" }, { id: IDEAS, name: "Ideas" }];
const MAX_LISTS = 12;
state.lists = DEFAULT_LISTS;
// A task with no list, or whose list was removed, belongs to the first ordinary list
function listOf(t) {
  if (state.lists.some((l) => l.id === t.list)) return t.list;
  return (state.lists.find((l) => l.id !== IDEAS) || state.lists[0]).id;
}
function lastList() {
  const id = pref("last-list", "");
  return state.lists.some((l) => l.id === id && id !== IDEAS) ? id : listOf({});
}
const byPriority = (a, b) => priRank(a) - priRank(b) || a.createdAt - b.createdAt;
const openTasks = () => state.tasks.filter((t) => !t.done && listOf(t) !== IDEAS).sort(byPriority);
function doneToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return state.tasks.filter((t) => t.done && t.doneAt >= start.getTime()).length;
}
const openIdeas = () => state.tasks.filter((t) => !t.done && listOf(t) === IDEAS).sort(byPriority);
const doneTasks = () => state.tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

function taskRef(id) {
  return fb.doc(fb.db, "users", state.user.uid, "tasks", id);
}

// Writes go to the local copy instantly and sync in the background.
function save(promise) {
  promise.catch((e) => {
    console.error(e);
    toast("Couldn't save that change. Check your connection.");
  });
}

function addTask(raw, list) {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title) return false;
  const ref = fb.doc(fb.collection(fb.db, "users", state.user.uid, "tasks"));
  const now = Date.now(), into = state.lists.some((l) => l.id === list) ? list : lastList();
  if (into !== IDEAS) setPref("last-list", into);
  save(fb.setDoc(ref, { title, done: false, deleted: false, createdAt: now, updatedAt: now, doneAt: null, list: into }));
  return true;
}
function setTaskList(task, list) {
  if (!state.lists.some((l) => l.id === list)) return;
  save(fb.updateDoc(taskRef(task.id), { list, updatedAt: Date.now() }));
}
function setTaskMins(task, mins) {
  save(fb.updateDoc(taskRef(task.id), { mins: [15, 30, 60, 120].includes(mins) ? mins : null, updatedAt: Date.now() }));
}
function listsRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "lists"); }
function saveLists(lists) {
  if (!state.listsLoaded) { toast("Your lists haven't loaded yet. Check your connection and try again."); return; }
  state.lists = lists;
  renderLists();
  if (!isEditingTask()) renderTodoPage();
  renderTodayCard();
  save(fb.setDoc(listsRef(), { lists, updatedAt: Date.now() }));
}
async function loadLists() {
  state.lists = DEFAULT_LISTS; state.listsLoaded = false;
  try {
    const snap = await fb.getDoc(listsRef());
    state.listsLoaded = true;   // a failed read must never let the defaults overwrite your lists
    const raw = snap.exists() ? snap.data().lists : null;
    if (Array.isArray(raw)) {
      const seen = new Set();
      const lists = raw.filter((l) => l && typeof l.id === "string" && l.id && !seen.has(l.id) && seen.add(l.id))
        .map((l) => ({ id: l.id.slice(0, 40), name: cleanCourse(l.name).slice(0, 30) || "List" })).slice(0, MAX_LISTS);
      if (lists.length) state.lists = lists;
    }
  } catch (e) { console.warn("Couldn't read your lists:", e); }
  renderLists();
  renderTasks();
}
function renderLists() {
  const host = $("list-list");
  if (!host) return;
  host.textContent = "";
  state.lists.forEach((l) => {
    const li = document.createElement("li");
    const name = document.createElement("input");
    name.type = "text"; name.maxLength = 30; name.value = l.name; name.className = "list-name";
    name.setAttribute("aria-label", "List name");
    name.addEventListener("change", () => {
      const next = cleanCourse(name.value).slice(0, 30);
      if (!next) { name.value = l.name; return; }
      saveLists(state.lists.map((x) => (x.id === l.id ? { ...x, name: next } : x)));
    });
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.setAttribute("aria-label", "Remove list: " + l.name);
    del.disabled = state.lists.filter((x) => x.id !== IDEAS).length <= 1 && l.id !== IDEAS;
    del.addEventListener("click", () => {
      const before = state.lists;
      saveLists(before.filter((x) => x.id !== l.id));
      toast("List removed. Its tasks moved to " + state.lists[0].name + ".", "Undo", () => saveLists(before));
    });
    li.append(name, del);
    host.appendChild(li);
  });
}
function addList(raw) {
  const name = cleanCourse(raw).slice(0, 30);
  if (!name) return false;
  if (state.lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) { toast("That list already exists."); return false; }
  if (state.lists.length >= MAX_LISTS) { toast("That's the limit of " + MAX_LISTS + " lists."); return false; }
  saveLists([...state.lists, { id: "l" + Date.now().toString(36), name }]);
  return true;
}

function toggleTask(task) {
  const done = !task.done;
  if (done) playTick();
  save(fb.updateDoc(taskRef(task.id), { done, doneAt: done ? Date.now() : null, updatedAt: Date.now() }));
}

function renameTask(task, raw) {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title || title === task.title) return;
  save(fb.updateDoc(taskRef(task.id), { title, updatedAt: Date.now() }));
}

function setTaskDue(task, due) {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(due || "") ? due : null;
  if (value === (task.due || null)) return;
  save(fb.updateDoc(taskRef(task.id), { due: value, updatedAt: Date.now() }));
}

function setTaskPriority(task, priority) {
  save(fb.updateDoc(taskRef(task.id), { priority: PRIORITIES.includes(priority) && priority !== "normal" ? priority : null, updatedAt: Date.now() }));
}
function setTaskCourse(task, course) {
  save(fb.updateDoc(taskRef(task.id), { course: cleanCourse(course) || null, updatedAt: Date.now() }));
}

// ---- Subjects: one list (users/{uid}/settings/courses) that tasks and the missed-questions form pick from
const MAX_COURSES = 30;
function cleanCourse(raw) { return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 40); }
function coursesRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "courses"); }
function saveCourses(list) {
  state.courses = list;
  renderCourses();
  if (!isEditingTask()) renderTodoPage();
  // keep only the colours of subjects still on the list
  const colors = Object.fromEntries(list.filter((c) => state.courseColors[c]).map((c) => [c, state.courseColors[c]]));
  save(fb.setDoc(coursesRef(), { list, colors, updatedAt: Date.now() }));
}
function courseColour(name) { return state.courseColors[name] || theme.defaultColour(name, state.courses.indexOf(name)); }
function setCourseColour(name, colour) {
  if (!theme.isColour(colour)) return;
  state.courseColors = { ...state.courseColors, [name]: colour.toUpperCase() };
  saveCourses(state.courses);
}
async function loadCourses() {
  state.courses = [];
  try {
    const snap = await fb.getDoc(coursesRef());
    const list = snap.exists() ? snap.data().list : null;
    if (Array.isArray(list)) state.courses = [...new Set(list.map(cleanCourse).filter(Boolean))].slice(0, MAX_COURSES);
    const colors = snap.exists() ? snap.data().colors : null;
    state.courseColors = {};
    if (colors && typeof colors === "object") state.courses.forEach((c) => { if (theme.isColour(colors[c])) state.courseColors[c] = colors[c].toUpperCase(); });
  } catch (e) { console.warn("Couldn't read your subjects:", e); }
  renderCourses();
  if (!isEditingTask()) renderTodoPage();
}
// One name, or several separated by commas or new lines ("BIO 2000, Chem 1130")
function addCourse(raw) {
  const names = String(raw || "").split(/[,;\n]+/).map(cleanCourse).filter(Boolean);
  if (names.length > 1) {
    const have = new Set(state.courses.map((c) => c.toLowerCase())), fresh = [];
    names.forEach((n) => { if (!have.has(n.toLowerCase()) && state.courses.length + fresh.length < MAX_COURSES) { have.add(n.toLowerCase()); fresh.push(n); } });
    if (!fresh.length) { toast("Those subjects are already on the list."); return false; }
    saveCourses([...state.courses, ...fresh]);
    toast("Added " + fresh.length + " subjects");
    return true;
  }
  const name = names[0];
  if (!name) return false;
  if (state.courses.some((c) => c.toLowerCase() === name.toLowerCase())) { toast("That subject is already on the list."); return false; }
  if (state.courses.length >= MAX_COURSES) { toast("That's the limit of " + MAX_COURSES + " subjects."); return false; }
  saveCourses([...state.courses, name]);
  return true;
}
function renderCourses() {
  const host = $("course-list"), options = $("course-options");
  if (!host) return;
  applyLook();
  host.textContent = ""; options.textContent = "";
  if (!state.courses.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No subjects yet.";
    host.appendChild(li);
  }
  state.courses.forEach((c) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = c;
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "course-colour";
    swatch.value = courseColour(c).toLowerCase();
    swatch.setAttribute("aria-label", "Colour for " + c);
    swatch.addEventListener("change", () => setCourseColour(c, swatch.value));
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.setAttribute("aria-label", "Remove subject: " + c);
    del.addEventListener("click", () => {
      const before = state.courses;
      saveCourses(before.filter((x) => x !== c));
      toast("Subject removed", "Undo", () => saveCourses(before));
    });
    li.append(swatch, name, del);
    host.appendChild(li);
    const o = document.createElement("option");
    o.value = c;
    options.appendChild(o);
  });
}
function todoFilter() { try { return localStorage.getItem("hb-todo-course") || ""; } catch (e) { return ""; } }

// "2026-11-17" -> "Today", "Tomorrow", "Tue, Nov 17"
function dueLabel(due) {
  const [y, m, d] = due.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const diff = Math.round((date - startOfDay(new Date())) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// Open tasks due on a day, shaped like all-day calendar items so they show as chips there
function tasksDue(date) {
  const key = ymd(date), s = startOfDay(date).getTime();
  return openTasks().filter((t) => t.due === key)
    .map((t) => ({ id: "task:" + t.id, title: t.title, allDay: true, cat: "task", task: t, startMs: s, endMs: s + 86400000 }));
}

function deleteTask(task) {
  save(fb.updateDoc(taskRef(task.id), { deleted: true, deletedAt: Date.now(), updatedAt: Date.now() }));
  toast("Task deleted", "Undo", () => {
    save(fb.updateDoc(taskRef(task.id), { deleted: false, deletedAt: null, updatedAt: Date.now() }));
  });
}

// ================================================================ TASKS (view)
// "Read BIO (Ch. 7–8)" -> name "Read BIO", detail "(Ch. 7–8)" shown in grey
function splitTitle(title) {
  const m = title.match(/^(.*?)\s*(\([^()]*\))\s*$/);
  return m && m[1] ? [m[1], m[2]] : [title, ""];
}

// full = the To-Do tab, where there's room for the priority flag and the subject picker
function taskItem(task, full) {
  const li = document.createElement("li");
  const pri = task.priority === "high" || task.priority === "low" ? task.priority : "normal";
  li.className = "task" + (task.done ? " is-done" : "") + (pri !== "normal" && !task.done ? " pri-" + pri : "");

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", (task.done ? "Mark not done: " : "Mark done: ") + task.title);
  check.setAttribute("aria-pressed", task.done ? "true" : "false");
  check.addEventListener("click", () => {
    if (task.done) { toggleTask(task); return; }
    li.classList.add("check-anim");
    // Let the tick land, then fold the row away before the list redraws
    setTimeout(() => {
      li.style.height = li.offsetHeight + "px";
      void li.offsetHeight;
      li.classList.add("collapsing");
      setTimeout(() => toggleTask(task), 190);
    }, 260);
  });

  // Tap the name to rename the task
  const text = document.createElement("span");
  text.className = "task-title";
  text.tabIndex = 0;
  text.setAttribute("role", "button");
  text.setAttribute("aria-label", "Rename: " + task.title);
  const [name, detail] = splitTitle(task.title);
  text.textContent = name;
  if (detail) {
    const d = document.createElement("span");
    d.className = "detail";
    d.textContent = " " + detail;
    text.appendChild(d);
  }
  text.addEventListener("click", () => editTask(task, text));
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); editTask(task, text); }
  });

  // Due date: tap to pick one. Tasks with a date also show on the calendar that day.
  const dueWrap = document.createElement("span");
  const overdue = !!task.due && !task.done && task.due < ymd(new Date());
  dueWrap.className = "due" + (task.due ? " has-due" : "") + (overdue ? " is-over" : "");
  const dueText = document.createElement("span");
  dueText.setAttribute("aria-hidden", "true");
  if (task.due) dueText.textContent = dueLabel(task.due);
  else dueText.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const picker = document.createElement("input");
  picker.type = "date";
  picker.className = "due-input";
  picker.value = task.due || "";
  picker.setAttribute("aria-label", (task.due ? "Due " + dueLabel(task.due) + ". Change" : "Add a due date") + ": " + task.title);
  picker.addEventListener("click", () => { try { picker.showPicker(); } catch (e) { /* the tap itself opens it */ } });
  picker.addEventListener("change", () => { setTaskDue(task, picker.value); picker.blur(); });
  picker.addEventListener("blur", () => { picker.classList.remove("due-input"); renderTasks(); });
  dueWrap.append(dueText, picker);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.setAttribute("aria-label", "Delete: " + task.title);
  del.textContent = "×";
  del.addEventListener("click", () => deleteTask(task));

  li.append(check, text);
  if (full && state.lists.length > 1) {
    // Which list the task lives in; ideas also say how long they take
    const move = document.createElement("select");
    move.className = "task-pick list-pick";
    move.setAttribute("aria-label", "List: " + task.title);
    state.lists.forEach((l) => { const o = document.createElement("option"); o.value = l.id; o.textContent = l.name; move.appendChild(o); });
    move.value = listOf(task);
    move.addEventListener("change", () => setTaskList(task, move.value));
    li.appendChild(move);
    if (listOf(task) === IDEAS) {
      const mins = document.createElement("select");
      mins.className = "task-pick has-course";
      mins.setAttribute("aria-label", "Time needed: " + task.title);
      [[0, "Any time"], [15, "15 min"], [30, "30 min"], [60, "1 hour"], [120, "2 hours"]].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; mins.appendChild(o); });
      mins.value = task.mins || 0;
      mins.addEventListener("change", () => setTaskMins(task, Number(mins.value)));
      li.appendChild(mins);
    }
  }
  if (full) {
    const sel = document.createElement("select");
    sel.className = "course-pick" + (task.course ? " has-course" : "");
    if (task.course) sel.style.setProperty("--c", courseColour(task.course));
    sel.setAttribute("aria-label", "Subject: " + task.title);
    const names = task.course && !state.courses.includes(task.course) ? [task.course, ...state.courses] : state.courses;
    [["", task.course ? "No subject" : "Subject"], ...names.map((c) => [c, c]), ["__edit", "Edit subjects…"]].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = task.course || "";
    sel.addEventListener("change", () => {
      if (sel.value === "__edit") { sel.value = task.course || ""; location.hash = "#settings"; return; }
      setTaskCourse(task, sel.value);
    });
    const flag = document.createElement("button");
    flag.type = "button";
    flag.className = "pri";
    flag.textContent = pri === "low" ? "↓" : "!";
    const next = PRIORITIES[(PRIORITIES.indexOf(pri) + 1) % PRIORITIES.length];
    flag.setAttribute("aria-label", "Priority " + pri + ". Change to " + next + ": " + task.title);
    flag.title = "Priority: " + pri;
    flag.addEventListener("click", () => setTaskPriority(task, next));
    li.append(sel, flag);
  } else if (task.course) {
    const tag = document.createElement("span");
    tag.className = "task-course";
    tag.textContent = task.course;
    li.appendChild(tag);
  }
  li.append(dueWrap, del);
  return li;
}

// Swap the task name for a text box. Return or tapping away saves; Escape cancels.
function editTask(task, titleEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "task-edit";
  input.maxLength = MAX_TITLE;
  input.value = task.title;
  input.setAttribute("aria-label", "Task name");
  input.enterKeyHint = "done";
  let cancelled = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { cancelled = true; input.blur(); }
  });
  input.addEventListener("blur", () => {
    if (!cancelled) renameTask(task, input.value);
    input.classList.remove("task-edit");   // typing is over, so drawing is allowed again
    renderTasks();   // redraw now that typing is over (also picks up changes that arrived meanwhile)
  });
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}
const isEditingTask = () => {
  const el = document.activeElement;
  return !!(el && (el.classList.contains("task-edit") || el.classList.contains("due-input")));
};

function addForm(placeholder, list) {
  const form = document.createElement("form");
  form.className = "add-task";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = MAX_TITLE;
  input.placeholder = placeholder;
  input.setAttribute("aria-label", "New task");
  input.enterKeyHint = "done";
  const plus = document.createElement("span");
  plus.className = "plus";
  plus.setAttribute("aria-hidden", "true");
  plus.textContent = "+";
  form.append(plus, input);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (addTask(input.value, list)) input.value = "";
  });
  return form;
}

function skeleton(host) {
  host.textContent = "";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "skeleton";
    s.style.width = 60 + ((i * 17) % 30) + "%";
    host.appendChild(s);
  }
}

function errorBox(host, message) {
  host.textContent = "";
  const p = document.createElement("p");
  p.className = "empty";
  p.textContent = message + " ";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn-link";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => location.reload());
  p.appendChild(retry);
  host.appendChild(p);
}

function renderTodayCard() {
  const host = $("today-todo");
  if (state.status === "loading") return skeleton(host);
  if (state.status === "error") return errorBox(host, "Couldn't load your tasks.");
  host.textContent = "";
  const open = openTasks();
  if (open.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No tasks right now. Add one?";
    host.appendChild(p);
  } else {
    const ul = document.createElement("ul");
    ul.className = "tasks";
    open.slice(0, TODAY_LIMIT).forEach((t) => ul.appendChild(taskItem(t)));
    host.appendChild(ul);
    if (open.length > TODAY_LIMIT) {
      const more = document.createElement("a");
      more.href = "#todo";
      more.className = "more";
      more.textContent = "+" + (open.length - TODAY_LIMIT) + " more";
      host.appendChild(more);
    }
  }
  host.appendChild(addForm("Add a task"));
}

function renderTodoPage() {
  let host = $("todo-full");
  if (state.status === "loading") return skeleton(host);
  if (state.status === "error") return errorBox(host, "Couldn't load your tasks.");
  host.textContent = "";
  const main = document.createElement("div"), side = document.createElement("aside");
  main.className = "todo-main"; side.className = "todo-side";
  host.append(main, side);
  const hostAll = host;
  host = main;
  const view = state.lists.some((l) => l.id === pref("todo-list", "")) ? pref("todo-list", "") : "";
  const all = state.tasks.filter((t) => !t.done && (view ? listOf(t) === view : true)).sort(byPriority);
  const done = doneTasks();
  // Lists are the main switch
  const seg = $("todo-lists");
  seg.textContent = "";
  [["", "All"], ...state.lists.map((l) => [l.id, l.name])].forEach(([id, name]) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = name;
    b.setAttribute("aria-pressed", String(id === view));
    b.addEventListener("click", () => { setPref("todo-list", id); renderTodoPage(); });
    seg.appendChild(b);
  });
  const more = document.createElement("a");
  more.href = "#settings"; more.textContent = "+ New list";
  more.addEventListener("click", () => setTimeout(() => $("list-new").focus(), 60));
  seg.appendChild(more);
  // Filter by subject, offered once any open task has one
  const used = [...new Set(all.map((t) => t.course).filter(Boolean))].sort();
  const filter = used.includes(todoFilter()) ? todoFilter() : "";
  const open = filter ? all.filter((t) => t.course === filter) : all;
  if (used.length) {
    const pick = document.createElement("select");
    pick.className = "todo-filter";
    pick.setAttribute("aria-label", "Show tasks for");
    [["", "All subjects"], ...used.map((c) => [c, c])].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      pick.appendChild(o);
    });
    pick.value = filter;
    pick.addEventListener("change", () => { try { localStorage.setItem("hb-todo-course", pick.value); } catch (e) {} renderTodoPage(); });
    host.appendChild(pick);
  }

  if (open.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = view === IDEAS ? "Nothing here yet. Add things you'd enjoy doing when you have a free hour."
      : done.length ? "All done. Nice work." : "No tasks yet. Type one below and press Return.";
    host.appendChild(p);
  } else {
    // "All" shows each list that has something in it, under its name
    (view ? [state.lists.find((l) => l.id === view)] : state.lists).forEach((l) => {
      const items = open.filter((t) => listOf(t) === l.id);
      if (!items.length) return;
      if (!view) {
        const h = document.createElement("h3");
        h.className = "todo-section";
        h.textContent = l.name + " · " + items.length;
        host.appendChild(h);
      }
      const ul = document.createElement("ul");
      ul.className = "tasks";
      items.forEach((t) => ul.appendChild(taskItem(t, true)));
      host.appendChild(ul);
    });
  }
  const target = view || lastList();
  host.appendChild(addForm("Add a task to " + state.lists.find((l) => l.id === target).name, target));
  host = side;

  // Quizzes and assignments from your calendar (Canvas). Ticking one here clears it there too.
  const upcoming = upcomingDeadlines();
  if (upcoming.length) {
    const h = document.createElement("h3");
    h.className = "todo-section";
    h.textContent = "Deadlines · next 2 weeks";
    const ul = document.createElement("ul");
    ul.className = "tasks";
    upcoming.forEach((ev) => ul.appendChild(upcomingItem(ev)));
    host.append(h, ul);
  }

  if (done.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "completed-toggle";
    toggle.setAttribute("aria-expanded", String(state.showCompleted));
    toggle.classList.add("done-block");
    const big = document.createElement("b"), words = document.createElement("span"), small = document.createElement("small");
    big.textContent = doneToday();
    small.textContent = "Done today";
    words.append(small, (state.showCompleted ? "Hide finished tasks" : "Show finished tasks") + " · " + done.length);
    toggle.append(big, words);
    toggle.addEventListener("click", () => { state.showCompleted = !state.showCompleted; renderTodoPage(); });
    host.appendChild(toggle);
    if (state.showCompleted) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      done.forEach((t) => ul.appendChild(taskItem(t)));
      host.appendChild(ul);
    }
  }

  // Calendar deadlines you marked done (last 30 days). Untick one to put it back on the calendar.
  const deadlines = recentDoneDeadlines();
  if (deadlines.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "completed-toggle";
    toggle.setAttribute("aria-expanded", String(state.showDoneDeadlines));
    toggle.textContent = (state.showDoneDeadlines ? "▾ " : "▸ ") + "Done deadlines " + deadlines.length;
    toggle.addEventListener("click", () => { state.showDoneDeadlines = !state.showDoneDeadlines; renderTodoPage(); });
    host.appendChild(toggle);
    if (state.showDoneDeadlines) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      deadlines.forEach((d) => ul.appendChild(deadlineItem(d)));
      host.appendChild(ul);
    }
  }
}

const DEADLINE_DAYS_AHEAD = 14;
function upcomingDeadlines() {
  if (!state.events.length) return [];
  const from = startOfDay(new Date()).getTime(), to = addDays(startOfDay(new Date()), DEADLINE_DAYS_AHEAD + 1).getTime();
  const list = state.events.filter((e) => e.cat === "due" && e.startMs >= from && e.startMs < to && !state.doneEvents.has(e.id));
  return dedupe(list).sort((a, b) => a.startMs - b.startMs);
}
function upcomingItem(ev) {
  const li = document.createElement("li");
  li.className = "task";
  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", "Mark done: " + ev.title);
  check.setAttribute("aria-pressed", "false");
  check.addEventListener("click", () => {
    li.classList.add("check-anim");
    playTick();
    setTimeout(() => markEventDone(ev), 260);
  });
  const text = document.createElement("span");
  text.className = "task-title";
  text.tabIndex = 0;
  text.setAttribute("role", "button");
  text.setAttribute("aria-label", "Details: " + ev.title);
  text.textContent = ev.title;
  text.addEventListener("click", () => openEventSheet(ev));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEventSheet(ev); } });
  const due = document.createElement("span");
  due.className = "due has-due";
  due.textContent = dueLabel(ymd(new Date(ev.startMs))) + (ev.allDay ? "" : " · " + fmtTime(ev.startMs));
  li.append(check, text, due);
  return li;
}

const DONE_DEADLINE_DAYS = 30;
function recentDoneDeadlines() {
  const since = Date.now() - DONE_DEADLINE_DAYS * 86400000;
  return state.doneList.filter((d) => (d.updatedAt || 0) >= since && !d.eventId.startsWith("hifz:")).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function deadlineItem(d) {
  const li = document.createElement("li");
  li.className = "task is-done";
  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", "Put back on the calendar: " + d.title);
  check.setAttribute("aria-pressed", "true");
  check.addEventListener("click", () => {
    setEventDone({ id: d.eventId, title: d.title }, false);
    toast("Back on your calendar", "Undo", () => setEventDone({ id: d.eventId, title: d.title }, true));
  });
  const text = document.createElement("span");
  text.className = "task-title";
  text.textContent = d.title;
  li.append(check, text);
  return li;
}

function renderTasks() {
  if (isEditingTask()) return;   // don't wipe the text box mid-typing; it redraws when typing ends
  renderTodayCard();
  renderTodoPage();
  renderSummary();
  if (!drawingCalendar) renderCalendar();   // tasks with a due date show on the calendar
}
let drawingCalendar = false;

// ================================================================ AUTH
const AUTH_MESSAGES = {
  "auth/invalid-credential": "That email or password isn't right.",
  "auth/wrong-password": "That email or password isn't right.",
  "auth/user-not-found": "That email or password isn't right.",
  "auth/invalid-email": "That email doesn't look right.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes, then try again.",
  "auth/network-request-failed": "No internet connection. Connect and try again.",
  "auth/user-disabled": "This account has been turned off.",
};

function showSignIn(show) {
  $("signin").hidden = !show;
  document.querySelector(".app").setAttribute("aria-hidden", show ? "true" : "false");
  if (show) setTimeout(() => $("signin-email").focus(), 50);
}

function wireSignIn() {
  $("signin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const password = $("signin-password").value;
    const err = $("signin-error");
    err.textContent = "";
    if (!email || !password) { err.textContent = "Enter your email and password."; return; }
    if (!fb) { err.textContent = "Still loading. Try again in a moment."; return; }
    const btn = $("signin-btn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      await fb.signInWithEmailAndPassword(fb.auth, email, password);
      $("signin-password").value = "";
    } catch (ex) {
      err.textContent = AUTH_MESSAGES[ex.code] || "Couldn't sign in. Try again.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });

  $("forgot-btn").addEventListener("click", async () => {
    const email = $("signin-email").value.trim();
    const err = $("signin-error");
    if (!email) { err.textContent = "Type your email first, then tap Forgot password."; return; }
    if (!fb) return;
    try {
      await fb.sendPasswordResetEmail(fb.auth, email);
      err.textContent = "";
      toast("Check your email for a reset link.");
    } catch (ex) {
      err.textContent = AUTH_MESSAGES[ex.code] || "Couldn't send the email. Try again.";
    }
  });

  $("signout-btn").addEventListener("click", () => fb && fb.signOut(fb.auth));
}

// ================================================================ FIREBASE
async function loadFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  // initializeAuth (not getAuth) skips the hidden sign-in iframe that hangs
  // in iPhone home-screen apps. Email + password sign-in doesn't need it.
  const auth = authMod.initializeAuth(app, {
    persistence: [authMod.indexedDBLocalPersistence, authMod.browserLocalPersistence],
  });
  let db;
  try {
    // Keeps a copy on the device: the app opens instantly and works offline.
    db = fsMod.initializeFirestore(app, {
      localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("Offline copy unavailable, using online only:", e);
    db = fsMod.getFirestore(app);
  }
  fb = {
    auth, db,
    onAuthStateChanged: authMod.onAuthStateChanged,
    signInWithEmailAndPassword: authMod.signInWithEmailAndPassword,
    sendPasswordResetEmail: authMod.sendPasswordResetEmail,
    signOut: authMod.signOut,
    collection: fsMod.collection,
    doc: fsMod.doc,
    setDoc: fsMod.setDoc,
    deleteField: fsMod.deleteField,
    getDoc: fsMod.getDoc,
    updateDoc: fsMod.updateDoc,
    onSnapshot: fsMod.onSnapshot,
    query: fsMod.query,
    where: fsMod.where,
  };
}

function startTasks(user) {
  state.status = "loading";
  renderTasks();
  const col = fb.collection(fb.db, "users", user.uid, "tasks");
  unsubscribeTasks = fb.onSnapshot(col, (snap) => {
    state.tasks = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => !t.deleted && typeof t.title === "string");
    state.status = "ready";
    renderTasks();
  }, (e) => {
    console.error(e);
    state.status = "error";
    renderTasks();
  });
}

// Deadlines you've marked done live in users/{uid}/doneEvents, so both devices hide them.
let unsubscribeDone = null;
function startDone(user) {
  const col = fb.collection(fb.db, "users", user.uid, "doneEvents");
  unsubscribeDone = fb.onSnapshot(col, (snap) => {
    state.doneList = snap.docs.map((d) => d.data()).filter((d) => d.done && d.eventId)
      .map((d) => ({ eventId: String(d.eventId), title: String(d.title || "Deadline"), updatedAt: d.updatedAt || 0 }));
    state.doneEvents = new Set(state.doneList.map((d) => d.eventId));
    renderCalendar();
    if (!isEditingTask()) renderTodoPage();
  }, (e) => console.warn("Couldn't load done deadlines:", e));
}

function stopDone() {
  if (unsubscribeDone) unsubscribeDone();
  unsubscribeDone = null;
  state.doneEvents = new Set();
  state.doneList = [];
}

function doneRef(eventId) {
  return fb.doc(fb.db, "users", state.user.uid, "doneEvents", encodeURIComponent(eventId).slice(0, 1400));
}

function setEventDone(ev, done) {
  if (!fb || !state.user) return;
  // Update the screen right away; Firestore syncs in the background (and offline).
  state.doneList = state.doneList.filter((d) => d.eventId !== ev.id);
  if (done) { state.doneEvents.add(ev.id); state.doneList.push({ eventId: ev.id, title: ev.title, updatedAt: Date.now() }); }
  else state.doneEvents.delete(ev.id);
  renderCalendar();
  if (!isEditingTask()) renderTodoPage();
  fb.setDoc(doneRef(ev.id), { eventId: ev.id, title: ev.title, done, updatedAt: Date.now() })
    .catch((e) => { console.warn(e); toast("Couldn't save that. Try again."); });
}

function markEventDone(ev) {
  playTick();
  setEventDone(ev, true);
  toast("Marked done", "Undo", () => setEventDone(ev, false));
}

function stopTasks() {
  if (unsubscribeTasks) unsubscribeTasks();
  unsubscribeTasks = null;
  state.tasks = [];
  state.status = "loading";
}

async function startData() {
  // Never sit on a blank screen: if sign-in hasn't answered in 10 s, say so.
  let authAnswered = false;
  const watchdog = setTimeout(() => {
    if (authAnswered) return;
    state.status = "error";
    renderTasks();
    toast("Homebase is taking too long to connect.", "Try again", () => location.reload());
  }, 10000);
  try {
    await loadFirebase();
  } catch (e) {
    console.error(e);
    clearTimeout(watchdog);
    state.status = "error";
    renderTasks();
    toast("Couldn't load Homebase. Check your connection.", "Try again", () => location.reload());
    return;
  }
  fb.onAuthStateChanged(fb.auth, (user) => {
    authAnswered = true;
    clearTimeout(watchdog);
    stopTasks();
    state.user = user;
    $("account-line").hidden = !user;
    $("account-email").textContent = user ? user.email : "";
    showSignIn(!user);
    stopDone();
    stopSessions();
    stopGrowth();
    if (user) { startTasks(user); startDone(user); startSessions(user); startGrowth(user); loadCalendarSettings(user); loadKitLinks(); loadCourses(); loadLists(); startJournal(user); startScreenTime(user); }
    else {
      state.kitLinks = {};
      state.courses = []; state.courseColors = {}; renderCourses();
      state.lists = DEFAULT_LISTS; state.kits = []; renderLists(); renderKits(); stopJournal(); stopScreenTime();
      state.screenTime = {}; renderScreenTimeCard();
      renderTasks();
      state.calUrl = null; state.events = []; state.calStatus = "none"; renderCalendar();
    }
  });
}

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

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
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

function renderExamCard() {
  const host = $("exam-card");
  if (examKitEditing && host.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  host.textContent = "";
  if (state.calStatus === "loading" && !state.events.length) return skeleton(host);
  const exam = nextExam();
  if (!exam) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = state.calStatus === "ready" ? "No exams in the next 30 days." : "Connect your calendar to see exams.";
    host.appendChild(p);
    return;
  }
  const name = document.createElement("p");
  name.className = "exam-name";
  name.textContent = exam.title;
  const d = daysLeft(exam);
  const big = document.createElement("p");
  big.className = "exam-days";
  big.textContent = d <= 0 ? "Today" : d === 1 ? "Tomorrow" : d + " days";
  const when = document.createElement("p");
  when.className = "empty";
  when.textContent = new Date(exam.startMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
    (exam.allDay ? "" : " · " + fmtTime(exam.startMs));
  host.append(name, big, when);

  // Exam kit: one tap opens it. The link is saved per exam name and syncs.
  const key = kitKey(exam);
  const link = state.kitLinks[key];
  const row = document.createElement("div");
  row.className = "kit-row";
  if (link && !examKitEditing) {
    const open = document.createElement("a");
    open.className = "btn-primary kit-open";
    open.href = link; open.target = "_blank"; open.rel = "noopener";
    open.textContent = "Open exam kit";
    const change = document.createElement("button");
    change.type = "button"; change.className = "btn-link"; change.textContent = "Change link";
    change.addEventListener("click", () => { examKitEditing = true; renderExamCard(); });
    row.append(open, change);
  } else if (examKitEditing) {
    const form = document.createElement("form");
    form.className = "kit-form";
    form.noValidate = true;   // our own message below, not the browser's bubble
    const input = document.createElement("input");
    input.type = "url"; input.inputMode = "url"; input.placeholder = "Paste the exam kit link";
    input.value = link || ""; input.autocapitalize = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", "Exam kit link for " + exam.title);
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit"; saveBtn.className = "btn-primary"; saveBtn.textContent = "Save";
    const err = document.createElement("p");
    err.className = "form-error"; err.setAttribute("role", "alert");
    form.append(input, saveBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (url && !/^https:\/\/[^\s]+$/i.test(url)) { err.textContent = "That doesn't look like a link. It should start with https://"; return; }
      examKitEditing = false;
      saveKitLink(key, url);
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "btn-link"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { examKitEditing = false; renderExamCard(); });
    row.append(form, err, cancel);
    setTimeout(() => input.focus(), 0);
  } else {
    const add = document.createElement("button");
    add.type = "button"; add.className = "btn-link"; add.textContent = "Add exam kit link";
    add.addEventListener("click", () => { examKitEditing = true; renderExamCard(); });
    row.appendChild(add);
  }
  host.appendChild(row);
}
let examKitEditing = false;
const kitKey = (exam) => exam.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80) || "exam";
function kitsRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "kits"); }
function saveKitLink(key, url) {
  if (!state.kitsLoaded) { toast("Your kits haven't loaded yet. Check your connection and try again."); return; }
  const links = { ...state.kitLinks };
  if (url) links[key] = url; else delete links[key];
  state.kitLinks = links;
  renderExamCard();
  save(fb.setDoc(kitsRef(), { links, items: state.kits, updatedAt: Date.now() }));
}
// Exam kits listed in the Study tab: { id, title, url, course }
const cleanKit = (k) => {
  const title = cleanCourse(k && k.title).slice(0, 80), url = String((k && k.url) || "").trim().slice(0, 500);
  return title && /^https:\/\/\S+$/i.test(url) ? { id: String((k && k.id) || "k" + Math.random().toString(36).slice(2, 9)), title, url, course: cleanCourse(k && k.course) } : null;
};
function saveKits(items) {
  if (!state.kitsLoaded) { toast("Your kits haven't loaded yet. Check your connection and try again."); return; }
  state.kits = items.slice(0, 60);
  renderKits();
  save(fb.setDoc(kitsRef(), { links: state.kitLinks, items: state.kits, updatedAt: Date.now() }));
}
function pendingKits() { try { return (JSON.parse(sessionStorage.getItem("hb-kit-import") || "[]") || []).map(cleanKit).filter(Boolean); } catch (e) { return []; } }
function renderKits() {
  const host = $("kit-list"), pick = $("kit-course");
  if (!host) return;
  host.textContent = "";
  const keep = pick.value;
  pick.textContent = "";
  [["", "No subject"], ...state.courses.map((c) => [c, c])].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; pick.appendChild(o); });
  pick.value = state.courses.includes(keep) ? keep : "";
  const waiting = pendingKits().filter((k) => !state.kits.some((x) => x.url === k.url));
  if (waiting.length && state.user && state.kitsLoaded) {
    const box = document.createElement("div");
    box.className = "kit-import";
    const text = document.createElement("span");
    text.textContent = waiting.length + (waiting.length === 1 ? " exam kit is" : " exam kits are") + " ready to add.";
    const add = document.createElement("button");
    add.type = "button"; add.className = "btn-primary"; add.textContent = "Add all";
    add.addEventListener("click", () => { try { sessionStorage.removeItem("hb-kit-import"); } catch (e) {} saveKits([...state.kits, ...waiting]); });
    box.append(text, add);
    host.appendChild(box);
  }
  if (!state.kits.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No kits yet. Add the link to any exam kit and it opens from here in one tap.";
    host.appendChild(p);
    return;
  }
  const groups = [...new Set(state.kits.map((k) => k.course || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  groups.forEach((g) => {
    const h = document.createElement("h3");
    h.className = "list-head";
    h.textContent = g || "Other";
    const ul = document.createElement("ul");
    ul.className = "kit-rows";
    state.kits.filter((k) => (k.course || "") === g).forEach((k) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = k.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = k.title;
      if (g) a.style.setProperty("--c", courseColour(g));
      const del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.textContent = "×";
      del.setAttribute("aria-label", "Remove kit: " + k.title);
      del.addEventListener("click", () => { const before = state.kits; saveKits(before.filter((x) => x.id !== k.id)); toast("Kit removed", "Undo", () => saveKits(before)); });
      li.append(a, del);
      ul.appendChild(li);
    });
    host.append(h, ul);
  });
}
async function loadKitLinks() {
  state.kitLinks = {}; state.kits = []; state.kitsLoaded = false;
  try {
    const snap = await fb.getDoc(kitsRef());
    const links = snap.exists() ? snap.data().links : null;
    const items = snap.exists() ? snap.data().items : null;
    state.kits = Array.isArray(items) ? items.map(cleanKit).filter(Boolean).slice(0, 60) : [];
    state.kitsLoaded = true;   // only now is it safe to save kits: a failed read must never overwrite them
    if (links && typeof links === "object") {
      state.kitLinks = Object.fromEntries(Object.entries(links).filter(([, v]) => typeof v === "string" && /^https:\/\//i.test(v)));
    }
  } catch (e) { console.warn("Couldn't read exam kit links:", e); }
  renderExamCard();
  renderKits();
}

// ================================================================ CALENDAR TAB
// Mac: a week grid like Apple Calendar. iPhone: a week strip with the chosen day below.
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

function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

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

// ================================================================ STUDY TIMER
// Tap ▶ on a yellow study block to start; the timer shows at the bottom of the
// sidebar (Mac) or above the tab bar (iPhone) on every screen. Sessions sync
// between devices in users/{uid}/sessions, in the shape the Learning Time
// Tracker spec needs later (start, end, course, topic, method, focus, note).
const STALE_MS = 4 * 3600000;        // a timer running this long probably wasn't stopped
const BLOCK_GRACE_MS = 15 * 60000;   // ...and neither was one still going 15 min after its block ended
const SNOOZE_MS = 60 * 60000;        // "I'm still going" waits an hour before asking again
const timer = { running: null, recent: [], unsubRunning: null, unsubRecent: null, tick: null };

// When to ask "still studying?": 15 min after the calendar block ends (if the timer was
// started before it ended), otherwise after 4 hours.
function staleAt(s) {
  const afterBlock = s.eventEnd && s.eventEnd > s.start ? s.eventEnd + BLOCK_GRACE_MS : Infinity;
  return Math.min(afterBlock, s.start + STALE_MS);
}
// "I'm still going" is remembered on this device, so reopening the app doesn't ask again straight away.
function snoozedUntil(s) {
  try { return Number(localStorage.getItem("hb-timer-snooze:" + s.id)) || 0; } catch (e) { return 0; }
}
function snooze(s) {
  try { localStorage.setItem("hb-timer-snooze:" + s.id, String(Date.now() + SNOOZE_MS)); } catch (e) {}
}
function checkStale() {
  const s = timer.running;
  if (!s || staleSession || !$("session-sheet").hidden) return;
  if (Date.now() >= Math.max(staleAt(s), snoozedUntil(s))) openStaleSheet(s);
}

function sessionRef(id) { return fb.doc(fb.db, "users", state.user.uid, "sessions", id); }

// "Chem 1130 study block" -> "Chem 1130"; "ʿAlim Class — Study with Jabrail" -> "ʿAlim Class"
function guessCourse(title) {
  const first = title.split(/\s+[—–-]\s+/)[0];
  const t = first.replace(/\b(study|studying|block|session|review|prep|practice|revision)\b/gi, "").replace(/\s+/g, " ").trim();
  // "Study session with Jabrail" leaves just "with Jabrail", which isn't a course. Use the full title.
  if (!t || /^(with|for|and|&|at|on)\b/i.test(t)) return title;
  return t;
}

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + " min";
  const h = Math.floor(m / 60), r = m % 60;
  return h + " h" + (r ? " " + r + " min" : "");
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

// Minutes already logged for a calendar block (shown on the block)
function loggedFor(ev) {
  // Same block on the same day (a block that repeats daily shares one id)
  const day = startOfDay(new Date(ev.startMs)).getTime();
  return timer.recent.filter((s) => s.eventId === ev.id && s.status === "done" && s.end && startOfDay(new Date(s.start)).getTime() === day)
    .reduce((sum, s) => sum + (s.end - s.start), 0);
}

function startSession(ev) {
  if (!fb || !state.user) return;
  unlockAudio();
  const now = Date.now();
  if (timer.running) {
    const prev = timer.running;
    finishSession(prev, now, true);
    toast("Saved " + fmtDuration(now - prev.start) + " of " + prev.label + ". Started " + guessCourse(ev.title) + ".");
  }
  const ref = fb.doc(fb.collection(fb.db, "users", state.user.uid, "sessions"));
  const session = {
    status: "running", start: now, end: null,
    label: ev.title, course: ev.id === null ? ev.title : guessCourse(ev.title), topic: null, method: null,
    eventId: ev.id, eventEnd: ev.endMs, focus: null, note: "", updatedAt: now,
  };
  timer.running = { id: ref.id, ...session };   // show it right away; Firestore catches up
  renderTimer();
  renderCalendar();
  save(fb.setDoc(ref, session));
}

function finishSession(s, endMs, quiet) {
  const end = Math.max(s.start + 1000, endMs);
  if (timer.running && timer.running.id === s.id) timer.running = null;
  const done = { ...s, status: "done", end };
  timer.recent = [done, ...timer.recent.filter((x) => x.id !== s.id)];
  save(fb.updateDoc(sessionRef(s.id), { status: "done", end, updatedAt: Date.now() }));
  renderTimer();
  renderCalendar();
  renderStudy();
  renderGoals();
  if (!quiet) openSessionSheet(done);
}

function stopSession() {
  if (timer.running) { playTick(); finishSession(timer.running, Date.now(), false); }
}

// ---------- Study tab: start a session, stats, and the last week's log ----------
const STATS_DAYS = 35;   // how far back sessions are loaded (enough for streaks and last week)
const doneSessions = () => timer.recent.filter((s) => s.status === "done" && s.end);
const sumTime = (list) => list.reduce((sum, s) => sum + (s.end - s.start), 0);
// Study days in a row, counting back from today (or from yesterday, if today hasn't started yet)
function studyStreak() {
  const days = new Set(doneSessions().map((s) => startOfDay(new Date(s.start)).getTime()));
  let d = startOfDay(new Date());
  if (!days.has(d.getTime())) d = addDays(d, -1);
  let n = 0;
  while (days.has(d.getTime())) { n++; d = addDays(d, -1); }
  return n;
}
function weekStats() {
  const ws = startOfWeek(new Date()).getTime(), prev = addDays(new Date(ws), -7).getTime();
  const all = doneSessions();
  return { thisWeek: sumTime(all.filter((s) => s.start >= ws)), lastWeek: sumTime(all.filter((s) => s.start >= prev && s.start < ws)) };
}

function renderStudy() {
  const host = $("study-week");
  if (!host || $("view-study").hidden) return;
  host.textContent = "";
  const weekAgo = addDays(startOfDay(new Date()), -7).getTime();
  const sessions = doneSessions().filter((s) => s.start >= weekAgo).sort((a, b) => b.start - a.start);
  if (!doneSessions().length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No sessions yet. Press ▶ on a study block, or start one above.";
    host.appendChild(p);
    return;
  }
  // Three headline numbers: this week (against last week), streak, sessions
  const { thisWeek, lastWeek } = weekStats();
  const streak = studyStreak();
  const tiles = document.createElement("div");
  tiles.className = "study-tiles";
  const tile = (label, value, note, cls) => {
    const box = document.createElement("div");
    const l = document.createElement("span"); l.textContent = label;
    const v = document.createElement("p"); v.className = cls || "study-num"; v.textContent = value;
    const n = document.createElement("span"); n.textContent = note;
    box.append(l, v, n);
    tiles.appendChild(box);
  };
  const diff = thisWeek - lastWeek;
  tile("This week", fmtDuration(thisWeek),
    lastWeek === 0 ? "Nothing logged last week" : diff >= 0 ? "+" + fmtDuration(diff) + " on last week" : fmtDuration(-diff) + " to match last week", "study-total");
  tile("Streak", streak + (streak === 1 ? " day" : " days"), streak === 0 ? "Study today to start one" : "in a row");
  tile("Sessions", String(sessions.length), "in the last 7 days");
  host.appendChild(tiles);
  // Problems first: how much of this week's tagged study was working problems
  const ws = startOfWeek(new Date()).getTime();
  const tagged = doneSessions().filter((s) => s.start >= ws && s.method);
  if (tagged.length) {
    const probs = sumTime(tagged.filter((s) => s.method === "problems"));
    const all = sumTime(tagged);
    const p = document.createElement("p");
    p.className = "study-mix";
    p.textContent = "Problems: " + fmtDuration(probs) + " of " + fmtDuration(all) + " tagged this week (" + Math.round(100 * probs / all) + "%)" +
      (probs / all < 0.5 ? ". Aim for at least half." : ". Good.");
    host.appendChild(p);
  }
  if (!sessions.length) return;

  // Time per course, longest first
  const byCourse = new Map();
  sessions.forEach((s) => { const k = s.course || s.label || "Study"; byCourse.set(k, (byCourse.get(k) || 0) + (s.end - s.start)); });
  const courses = [...byCourse.entries()].sort((a, b) => b[1] - a[1]);
  const bars = document.createElement("div");
  bars.className = "study-bars";
  courses.forEach(([name, ms]) => {
    const row = document.createElement("div");
    row.className = "study-bar";
    const label = document.createElement("span");
    label.textContent = name;
    const track = document.createElement("i");
    track.style.setProperty("--w", Math.max(4, Math.round(100 * ms / courses[0][1])) + "%");
    const time = document.createElement("b");
    time.textContent = fmtDuration(ms);
    row.append(label, track, time);
    bars.appendChild(row);
  });
  host.appendChild(bars);

  // Every session, newest first, grouped by day. Tap one to change its rating or note, or delete it.
  let lastDay = null, ul = null;
  sessions.forEach((s) => {
    const day = startOfDay(new Date(s.start)).getTime();
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("h3");
      h.className = "study-day";
      const diff = Math.round((startOfDay(new Date()).getTime() - day) / 86400000);
      h.textContent = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : new Date(day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
      ul = document.createElement("ul");
      ul.className = "sessions";
      host.append(h, ul);
    }
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session-row";
    const name = document.createElement("strong");
    name.textContent = s.course || s.label;
    const when = document.createElement("span");
    when.textContent = fmtTime(s.start) + " – " + fmtTime(s.end) + (s.focus ? " · focus " + s.focus + "/5" : "") + (s.note ? " · " + s.note : "");
    const dur = document.createElement("b");
    dur.textContent = fmtDuration(s.end - s.start);
    btn.append(name, when, dur);
    btn.setAttribute("aria-label", name.textContent + ", " + dur.textContent + ", " + when.textContent + ". Edit");
    btn.addEventListener("click", () => openSessionSheet(s));
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

// ---------- End-of-day card (Today screen, from 8 PM) ----------
function renderWindDown() {
  const card = $("wind-card");
  if (!card) return;
  const now = new Date();
  const show = now.getHours() >= 20 && state.status === "ready";
  card.hidden = !show;
  if (!show) return;
  const host = $("wind");
  host.textContent = "";
  const today = startOfDay(now).getTime();
  const line = (text) => { const p = document.createElement("p"); p.textContent = text; host.appendChild(p); };
  const doneToday = state.tasks.filter((t) => !t.deleted && t.done && t.doneAt >= today).length;
  const studied = sumTime(doneSessions().filter((s) => s.start >= today));
  const streak = studyStreak();
  if (doneToday) line("✓ " + doneToday + (doneToday === 1 ? " task done" : " tasks done"));
  if (studied >= 60000) line("✓ " + fmtDuration(studied) + " studied");
  if (streak >= 2) line(streak + " study days in a row");
  if (!doneToday && studied < 60000) line("A quiet day. That's allowed.");
  // Tomorrow's first block
  if (state.calStatus === "ready") {
    const tomorrow = addDays(startOfDay(now), 1);
    const first = eventsForDay(tomorrow, poolFor(tomorrow)).filter(isBlock)[0];
    const p = document.createElement("p");
    p.className = "wind-next";
    p.textContent = first ? "Tomorrow starts with " + first.title + " at " + fmtTime(first.startMs) + "." : "Nothing on the calendar tomorrow.";
    host.appendChild(p);
  }
}

// ---------- Screen Time card ----------
function screenTimeRef(day) { return fb.doc(fb.db, "users", state.user.uid, "screentime", day); }

let unsubscribeScreenTime = null;
function startScreenTime(user) {
  const col = fb.collection(fb.db, "users", user.uid, "screentime");
  unsubscribeScreenTime = fb.onSnapshot(col, (snap) => {
    state.screenTime = {};
    snap.docs.forEach((d) => { state.screenTime[d.id] = d.data(); });
    renderScreenTimeCard();
  }, () => renderScreenTimeCard());
}
function stopScreenTime() { if (unsubscribeScreenTime) { unsubscribeScreenTime(); unsubscribeScreenTime = null; } }

function renderScreenTimeCard() {
  const host = $("screen-time-body");
  if (!host) return;
  host.textContent = "";
  const now = new Date();
  const today = ymd(now);

  // Build last 7 days of data
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = ymd(addDays(now, -i));
    days.push({ date: d, data: state.screenTime[d] || null });
  }

  // Bar chart: 7 days
  const chart = document.createElement("div");
  chart.className = "st-chart";
  const maxMins = Math.max(60, ...days.map((d) => (d.data ? d.data.total || 0 : 0)));
  days.forEach(({ date, data }) => {
    const col = document.createElement("div");
    col.className = "st-col";
    const bar = document.createElement("i");
    bar.className = "st-bar" + (date === today ? " st-today" : "");
    const pct = data && data.total ? Math.max(6, Math.round(100 * data.total / maxMins)) : 0;
    bar.style.setProperty("--h", pct + "%");
    const label = document.createElement("span");
    label.className = "st-day";
    const dow = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "narrow" });
    label.textContent = dow;
    if (data && data.total) {
      const h = Math.floor(data.total / 60), m = data.total % 60;
      bar.setAttribute("title", (h ? h + "h " : "") + m + "m");
    }
    col.append(bar, label);
    chart.appendChild(col);
  });
  host.appendChild(chart);

  // Today's total + top apps (or prompt to log)
  const todayData = state.screenTime[today];
  const summary = document.createElement("div");
  summary.className = "st-summary";
  if (todayData && todayData.total) {
    const h = Math.floor(todayData.total / 60), m = todayData.total % 60;
    const total = document.createElement("p");
    total.className = "st-total";
    total.textContent = "Today: " + (h ? h + "h " : "") + m + "m";
    summary.appendChild(total);
    if (todayData.apps && todayData.apps.length) {
      const apps = document.createElement("ul");
      apps.className = "st-apps";
      todayData.apps.slice(0, 3).forEach((a) => {
        const li = document.createElement("li");
        li.textContent = a;
        apps.appendChild(li);
      });
      summary.appendChild(apps);
    }
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "btn-link st-edit"; edit.textContent = "Edit";
    edit.addEventListener("click", () => openScreenTimeSheet(today, todayData));
    summary.appendChild(edit);
  } else {
    const prompt = document.createElement("p");
    prompt.className = "empty";
    prompt.textContent = "No screen time logged today.";
    summary.appendChild(prompt);
  }
  host.appendChild(summary);

  // Log button
  const log = document.createElement("button");
  log.type = "button"; log.className = "btn-primary st-log";
  log.textContent = todayData && todayData.total ? "Update today" : "Log today";
  log.addEventListener("click", () => openScreenTimeSheet(today, todayData || {}));
  host.appendChild(log);
}

// Sheet for entering / editing a day's screen time
let stSheet = null;
function openScreenTimeSheet(day, existing) {
  // Reuse the stale-sheet backdrop pattern: build a simple inline form
  const sheet = $("st-sheet");
  if (!sheet) {
    // Build once and cache
    const backdrop = document.createElement("div");
    backdrop.id = "st-sheet";
    backdrop.className = "sheet-backdrop";
    backdrop.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="st-sheet-title">
        <h2 id="st-sheet-title" class="sheet-title">Log Screen Time</h2>
        <label class="st-field-label" for="st-total-input">Total screen time (minutes)</label>
        <input id="st-total-input" type="number" min="0" max="1440" inputmode="numeric" class="st-input" placeholder="e.g. 180 for 3 hours">
        <label class="st-field-label" for="st-apps-input">Top apps <span class="st-hint">(one per line, e.g. Instagram: 45m)</span></label>
        <textarea id="st-apps-input" class="st-input st-textarea" rows="4" placeholder="Instagram: 45m&#10;YouTube: 30m&#10;Safari: 20m"></textarea>
        <div class="sheet-actions">
          <button type="button" id="st-save" class="btn-primary">Save</button>
          <button type="button" id="st-cancel" class="btn-link">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    $("st-cancel").addEventListener("click", closeScreenTimeSheet);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeScreenTimeSheet(); });
    $("st-save").addEventListener("click", saveScreenTime);
  }
  stSheet = { day };
  $("st-total-input").value = existing && existing.total ? existing.total : "";
  $("st-apps-input").value = existing && existing.apps ? existing.apps.join("\n") : "";
  $("st-sheet").hidden = false;
  setTimeout(() => $("st-total-input").focus(), 60);
}
function closeScreenTimeSheet() { $("st-sheet").hidden = true; stSheet = null; }
async function saveScreenTime() {
  if (!stSheet || !state.user) return;
  const totalRaw = parseInt($("st-total-input").value, 10);
  const total = isNaN(totalRaw) || totalRaw < 0 ? 0 : Math.min(totalRaw, 1440);
  const apps = $("st-apps-input").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const data = { total, apps, updatedAt: Date.now() };
  state.screenTime[stSheet.day] = data;
  renderScreenTimeCard();
  closeScreenTimeSheet();
  save(fb.setDoc(screenTimeRef(stSheet.day), data));
}

// ---------- Running timer bar ----------
function renderTimer() {
  const bar = $("timer-bar");
  const s = timer.running;
  document.body.classList.toggle("timer-on", !!s);
  bar.hidden = !s;
  clearInterval(timer.tick);
  if (!s) { applyLook(); return; }
  $("timer-label").textContent = s.course || s.label;
  applyLook();
  const update = () => { $("timer-time").textContent = fmtClock(Date.now() - s.start); };
  update();
  timer.tick = setInterval(update, 1000);
  checkStale();
}

// ---------- After stopping: optional focus rating and note ----------
let sheetSession = null;
function openSessionSheet(s) {
  sheetSession = s;
  $("session-title").textContent = "Logged " + fmtDuration(s.end - s.start);
  $("session-sub").textContent = s.label + " · " + fmtTime(s.start) + " – " + fmtTime(s.end);
  $("session-note").value = s.note || "";
  document.querySelectorAll("#focus-row button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === s.focus)));
  document.querySelectorAll("#method-row button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === s.method)));
  $("session-sheet").hidden = false;
}

function closeSessionSheet(saveIt) {
  const s = sheetSession;
  $("session-sheet").hidden = true;
  sheetSession = null;
  if (!s || !saveIt) return;
  const pressed = document.querySelector('#focus-row button[aria-pressed="true"]');
  const focus = pressed ? Number(pressed.dataset.v) : null;
  const note = $("session-note").value.trim().slice(0, 500);
  const m = document.querySelector('#method-row button[aria-pressed="true"]');
  const method = m ? m.dataset.v : null;
  if (focus !== s.focus || note !== (s.note || "") || method !== (s.method || null)) {
    timer.recent = timer.recent.map((x) => (x.id === s.id ? { ...x, focus, note, method } : x));
    save(fb.updateDoc(sessionRef(s.id), { focus, note, method, updatedAt: Date.now() }));
    renderStudy();
    renderGoals();
  }
}

function deleteSheetSession() {
  const s = sheetSession;
  $("session-sheet").hidden = true;
  sheetSession = null;
  if (!s) return;
  timer.recent = timer.recent.filter((x) => x.id !== s.id);
  save(fb.updateDoc(sessionRef(s.id), { status: "deleted", updatedAt: Date.now() }));
  renderCalendar();
  renderStudy();
  toast("Session deleted", "Undo", () => {
    save(fb.updateDoc(sessionRef(s.id), { status: "done", updatedAt: Date.now() }));
  });
}

// ---------- Forgot to stop? Ask, never log silently ----------
let staleSession = null;
function openStaleSheet(s) {
  staleSession = s;
  const startTxt = new Date(s.start).toLocaleDateString("en-US", { weekday: "short" }) + " " + fmtTime(s.start);
  const endBtn = $("stale-end");
  const canUseEnd = !!(s.eventEnd && s.eventEnd > s.start && s.eventEnd < Date.now());
  $("stale-text").textContent = "Your " + (s.course || s.label) + " timer has been running since " + startTxt +
    " (" + fmtDuration(Date.now() - s.start) + ")" +
    (canUseEnd ? ", and the block ended at " + fmtTime(s.eventEnd) : "") + ". When did you stop?";
  endBtn.hidden = !canUseEnd;
  if (canUseEnd) endBtn.textContent = "When the block ended (" + fmtTime(s.eventEnd) + ")";
  const d = new Date(canUseEnd ? s.eventEnd : Math.min(Date.now(), s.start + 3600000));
  $("stale-time").value = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  $("stale-error").textContent = "";
  $("stale-sheet").hidden = false;
}

function resolveStale(endMs) {
  const s = staleSession;
  $("stale-sheet").hidden = true;
  staleSession = null;
  if (s && endMs) finishSession(s, endMs, false);
}

// ---------- Sync ----------
function startSessions(user) {
  const col = fb.collection(fb.db, "users", user.uid, "sessions");
  timer.unsubRunning = fb.onSnapshot(fb.query(col, fb.where("status", "==", "running")), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.start - a.start);
    // Only one timer can run. If two devices started one, keep the newest and save the older.
    list.slice(1).forEach((old) => finishSession(old, Math.min(Date.now(), list[0].start), true));
    timer.running = list[0] || null;
    // Stopped on your other device: close the "still studying?" question here too
    if (staleSession && (!timer.running || timer.running.id !== staleSession.id)) {
      $("stale-sheet").hidden = true;
      staleSession = null;
    }
    renderTimer();
    renderCalendar();
  }, (e) => console.warn("Couldn't load the timer:", e));
  const since = addDays(startOfDay(new Date()), -STATS_DAYS).getTime();
  timer.unsubRecent = fb.onSnapshot(fb.query(col, fb.where("start", ">=", since)), (snap) => {
    timer.recent = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status === "done");
    renderCalendar();
    renderStudy();
    renderGoals();
  }, (e) => console.warn("Couldn't load study sessions:", e));
}

function stopSessions() {
  if (timer.unsubRunning) timer.unsubRunning();
  if (timer.unsubRecent) timer.unsubRecent();
  timer.unsubRunning = timer.unsubRecent = null;
  timer.running = null;
  timer.recent = [];
  $("stale-sheet").hidden = true;
  staleSession = null;
  renderTimer();
}

function wireTimer() {
  $("timer-stop").addEventListener("click", stopSession);
  // Study tab: time something that isn't on the calendar
  $("free-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const what = $("free-what").value.replace(/\s+/g, " ").trim().slice(0, 80);
    if (!what) { $("free-what").focus(); return; }
    startSession({ id: null, title: what, endMs: null });
    $("free-what").value = "";
  });
  $("session-save").addEventListener("click", () => closeSessionSheet(true));
  $("session-delete").addEventListener("click", deleteSheetSession);
  $("session-sheet").addEventListener("click", (e) => { if (e.target.id === "session-sheet") closeSessionSheet(true); });
  ["#focus-row", "#method-row"].forEach((row) => document.querySelectorAll(row + " button").forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    document.querySelectorAll(row + " button").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", String(on));
  })));
  $("stale-end").addEventListener("click", () => resolveStale(staleSession && staleSession.eventEnd));
  $("stale-now").addEventListener("click", () => resolveStale(Date.now()));
  $("stale-later").addEventListener("click", () => {
    if (staleSession) snooze(staleSession);
    $("stale-sheet").hidden = true;
    staleSession = null;
  });
  $("stale-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const s = staleSession;
    if (!s) return;
    const [h, m] = ($("stale-time").value || "").split(":").map(Number);
    if (isNaN(h) || isNaN(m)) { $("stale-error").textContent = "Pick a time."; return; }
    // The stop time is on the start day, or the next day if it's earlier than the start
    let end = new Date(s.start); end.setHours(h, m, 0, 0);
    if (end.getTime() <= s.start) end = addDays(end, 1);
    if (end.getTime() > Date.now()) { $("stale-error").textContent = "That time hasn't happened yet."; return; }
    resolveStale(end.getTime());
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("session-sheet").hidden) closeSessionSheet(true);
  });
  // Coming back to the app after a while: check for a forgotten timer
  document.addEventListener("visibilitychange", () => { if (!document.hidden) renderTimer(); });
}

// ================================================================ GROWTH (v17)
// Weekly goals, missed-questions bank and the Sunday review.
// Data: users/{uid}/growth/{weekStart yyyy-mm-dd} (one doc per week),
//       users/{uid}/missed/{id} (one doc per question), users/{uid}/settings/growth (focus project).
const FOCUS_GOAL_MIN = 60;     // one focused study block a day
const MEETUP_GOAL = 2;         // meetups a week
const MISS_FIRST_DAYS = 2;     // first redo
const MISS_SECOND_DAYS = 7;    // second redo
const growth = {
  status: "loading", weekKey: null, week: {}, project: "", missed: [],
  unsubs: [], editingProject: false, revealed: new Set(),
};

const weekKeyFor = (d) => ymd(startOfWeek(d));
function growthRef() { return fb.doc(fb.db, "users", state.user.uid, "growth", growth.weekKey); }
function growthSettingsRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "growth"); }
function missedRef(id) { return fb.doc(fb.db, "users", state.user.uid, "missed", id); }

function saveGrowth(promise) {
  promise.catch((e) => {
    console.error(e);
    toast(e && e.code === "permission-denied"
      ? "Homebase isn't allowed to save this yet. Firestore rules need updating."
      : "Couldn't save that change. Check your connection.");
  });
}

function listenWeek(user) {
  growth.weekKey = weekKeyFor(new Date());
  return fb.onSnapshot(fb.doc(fb.db, "users", user.uid, "growth", growth.weekKey), (snap) => {
    growth.week = snap.exists() ? snap.data() : {};
    growth.status = "ready";
    renderGoals();
  }, (e) => { console.warn("Couldn't load this week's goals:", e); growth.status = "error"; renderGoals(); });
}

function startGrowth(user) {
  growth.status = "loading";
  growth.unsubs.push(listenWeek(user));
  growth.unsubs.push(fb.onSnapshot(fb.doc(fb.db, "users", user.uid, "settings", "growth"), (snap) => {
    growth.project = snap.exists() ? String(snap.data().project || "") : "";
    renderGoals();
  }, (e) => console.warn("Couldn't load focus project:", e)));
  growth.unsubs.push(fb.onSnapshot(fb.collection(fb.db, "users", user.uid, "missed"), (snap) => {
    growth.missed = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((m) => m.status !== "deleted" && typeof m.q === "string");
    renderMissed();
    renderGoals();
  }, (e) => console.warn("Couldn't load missed questions:", e)));
  renderGoals();
}

function stopGrowth() {
  growth.unsubs.forEach((u) => u());
  growth.unsubs = [];
  growth.status = "loading"; growth.week = {}; growth.project = ""; growth.missed = [];
  renderGoals();
  renderMissed();
}

// A new week started while the app was open: switch to the new week's doc
function checkWeekRollover() {
  if (!state.user || !fb || growth.weekKey === weekKeyFor(new Date())) return;
  if (growth.unsubs[0]) growth.unsubs[0]();
  growth.unsubs[0] = listenWeek(state.user);
}

function updateWeek(fields) {
  if (!fb || !state.user) return;
  // Show it right away; Firestore syncs in the background
  const merged = { ...growth.week, ...fields };
  if (fields.humble) merged.humble = { ...(growth.week.humble || {}), ...fields.humble };
  if (fields.hifz) merged.hifz = { ...(growth.week.hifz || {}), ...fields.hifz };
  growth.week = merged;
  renderGoals();
  saveGrowth(fb.setDoc(growthRef(), { ...fields, updatedAt: Date.now() }, { merge: true }));
}

// ---------- Missed questions ----------
const missedOpen = () => growth.missed.filter((m) => m.status === "open");
const endOfToday = () => addDays(startOfDay(new Date()), 1).getTime();
const missedDue = () => missedOpen().filter((m) => m.dueAt < endOfToday()).sort((a, b) => a.dueAt - b.dueAt);
const dueIn = (days) => addDays(startOfDay(new Date()), days).getTime();

function addMissed(course, q, fix) {
  if (!fb || !state.user) return;
  const ref = fb.doc(fb.collection(fb.db, "users", state.user.uid, "missed"));
  const now = Date.now();
  const item = { course, q, fix, stage: 0, dueAt: dueIn(MISS_FIRST_DAYS), status: "open", misses: 1, createdAt: now, updatedAt: now };
  growth.missed = [...growth.missed, { id: ref.id, ...item }];
  renderMissed(); renderGoals();
  saveGrowth(fb.setDoc(ref, item));
}

function updateMissed(m, fields) {
  growth.missed = growth.missed.map((x) => (x.id === m.id ? { ...x, ...fields } : x)).filter((x) => x.status !== "deleted");
  renderMissed(); renderGoals();
  saveGrowth(fb.updateDoc(missedRef(m.id), { ...fields, updatedAt: Date.now() }));
}

function gotIt(m) {
  playTick();
  growth.revealed.delete(m.id);
  if (m.stage >= 1) {
    updateMissed(m, { status: "cleared", clearedAt: Date.now() });
    toast("Cleared. You got it right twice.", "Undo", () => updateMissed(m, { status: "open", stage: m.stage, dueAt: m.dueAt }));
  } else {
    updateMissed(m, { stage: 1, dueAt: dueIn(MISS_SECOND_DAYS) });
    toast("Nice. Back in a week.", "Undo", () => updateMissed(m, { stage: m.stage, dueAt: m.dueAt }));
  }
}

function missedAgain(m) {
  growth.revealed.delete(m.id);
  updateMissed(m, { stage: 0, dueAt: dueIn(MISS_FIRST_DAYS), misses: (m.misses || 1) + 1 });
  toast("Back in 2 days. Read the fix once more now.");
}

function deleteMissed(m) {
  updateMissed(m, { status: "deleted" });
  toast("Question removed", "Undo", () => {
    growth.missed = [...growth.missed, m];
    renderMissed(); renderGoals();
    saveGrowth(fb.updateDoc(missedRef(m.id), { status: m.status, updatedAt: Date.now() }));
  });
}

function shortDay(ms) {
  const diff = Math.round((ms - startOfDay(new Date()).getTime()) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString("en-US", diff < 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
}

function renderMissed() {
  const host = $("miss-list");
  if (!host) return;
  host.textContent = "";
  if (!state.user) return;
  const due = missedDue();
  const later = missedOpen().filter((m) => m.dueAt >= endOfToday()).sort((a, b) => a.dueAt - b.dueAt);
  const cleared = growth.missed.filter((m) => m.status === "cleared").length;
  const heading = (text) => { const h = document.createElement("h3"); h.className = "study-day"; h.textContent = text; host.appendChild(h); };

  if (due.length) {
    heading("Redo now · " + due.length);
    const ul = document.createElement("ul");
    ul.className = "miss-items";
    due.forEach((m) => {
      const li = document.createElement("li");
      li.className = "miss-item";
      const meta = document.createElement("span");
      meta.className = "miss-meta";
      meta.textContent = (m.course || "Question") + (m.stage >= 1 ? " · last redo" : " · first redo") + ((m.misses || 1) > 1 ? " · missed " + m.misses + "×" : "");
      const q = document.createElement("p");
      q.className = "miss-q";
      q.textContent = m.q;
      li.append(meta, q);
      if (m.fix) {
        if (growth.revealed.has(m.id)) {
          const fix = document.createElement("p");
          fix.className = "miss-fix";
          fix.textContent = m.fix;
          li.appendChild(fix);
        } else {
          const show = document.createElement("button");
          show.type = "button";
          show.className = "btn-link miss-show";
          show.textContent = "Answer it first, then show the fix";
          show.addEventListener("click", () => { growth.revealed.add(m.id); renderMissed(); });
          li.appendChild(show);
        }
      }
      const row = document.createElement("div");
      row.className = "miss-actions";
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "nav-btn miss-ok"; ok.textContent = "Got it";
      ok.addEventListener("click", () => gotIt(m));
      const again = document.createElement("button");
      again.type = "button"; again.className = "nav-btn"; again.textContent = "Missed again";
      again.addEventListener("click", () => missedAgain(m));
      row.append(ok, again);
      li.appendChild(row);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  } else if (missedOpen().length) {
    const p = document.createElement("p");
    p.className = "miss-none";
    p.textContent = "Nothing to redo today.";
    host.appendChild(p);
  }

  if (later.length) {
    heading("Coming up");
    const ul = document.createElement("ul");
    ul.className = "tasks";
    later.forEach((m) => {
      const li = document.createElement("li");
      li.className = "task miss-later";
      const when = document.createElement("b");
      when.textContent = shortDay(m.dueAt);
      const t = document.createElement("span");
      t.className = "task-title";
      t.textContent = (m.course ? m.course + " · " : "") + m.q;
      const del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.textContent = "×";
      del.setAttribute("aria-label", "Remove " + m.q);
      del.addEventListener("click", () => deleteMissed(m));
      li.append(when, t, del);
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }
  if (cleared) {
    const p = document.createElement("p");
    p.className = "muted-line miss-cleared";
    p.textContent = cleared + (cleared === 1 ? " question" : " questions") + " cleared so far.";
    host.appendChild(p);
  }
}

// ---------- This week card (Today) ----------
function goalRow(host, opts) {
  const row = document.createElement("div");
  row.className = "goal" + (opts.done ? " is-done" : "");
  if (opts.toggle) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "check";
    b.setAttribute("aria-pressed", String(!!opts.done));
    b.setAttribute("aria-label", opts.label);
    b.addEventListener("click", () => { if (!opts.done) playTick(); opts.toggle(!opts.done); });
    row.appendChild(b);
  } else {
    const mark = document.createElement("span");
    mark.className = "goal-mark";
    mark.textContent = opts.done ? "✓" : "";
    mark.setAttribute("aria-hidden", "true");
    row.appendChild(mark);
  }
  const text = document.createElement("div");
  text.className = "goal-text";
  const l = document.createElement("span");
  l.textContent = opts.label;
  text.appendChild(l);
  if (opts.note) { const n = document.createElement("small"); n.textContent = opts.note; text.appendChild(n); }
  row.appendChild(text);
  if (opts.extra) row.appendChild(opts.extra);
  host.appendChild(row);
  return row;
}

function renderGoals() {
  const host = $("goals");
  if (!host) return;
  if (!state.user || growth.status === "loading") {
    host.innerHTML = '<p class="empty">Loading…</p>';
    return;
  }
  if (growth.status === "error") {
    host.innerHTML = '<p class="empty">Couldn\'t load your goals. Check your connection.</p>';
    return;
  }
  host.textContent = "";
  const w = growth.week;
  const now = new Date();
  const today = ymd(now);

  // This week's fix from the Sunday review, at the top where you'll see it
  if (w.review && w.review.fix) {
    const fix = document.createElement("p");
    fix.className = "goal-fix";
    fix.textContent = "This week's fix: " + w.review.fix;
    host.appendChild(fix);
  }

  // Daily: one focused block
  const studied = Math.round(sumTime(doneSessions().filter((s) => s.start >= startOfDay(now).getTime())) / 60000);
  const bar = document.createElement("i");
  bar.className = "goal-bar";
  bar.style.setProperty("--w", Math.min(100, Math.round(100 * studied / FOCUS_GOAL_MIN)) + "%");
  goalRow(host, {
    label: "Focused study today",
    note: studied >= FOCUS_GOAL_MIN ? studied + " min. Done." : studied + " of " + FOCUS_GOAL_MIN + " min · problems first",
    done: studied >= FOCUS_GOAL_MIN, extra: bar,
  });

  // Daily: missed questions to redo
  const due = missedDue().length;
  const go = document.createElement("a");
  go.href = "#study";
  go.className = "goal-link";
  go.textContent = due ? "Redo" : "Add";
  goalRow(host, {
    label: "Missed questions",
    note: due ? due + " to redo today" : missedOpen().length ? "Nothing due today" : "Log every wrong answer",
    done: due === 0 && missedOpen().length > 0, extra: go,
  });

  // Daily: humility, with this week's days as dots
  const humble = w.humble || {};
  const dots = document.createElement("span");
  dots.className = "goal-dots";
  const ws = startOfWeek(now);
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const dot = document.createElement("i");
    if (humble[ymd(d)]) dot.className = "on";
    if (ymd(d) === today) dot.classList.add("today");
    dots.appendChild(dot);
  }
  dots.setAttribute("aria-label", Object.values(humble).filter(Boolean).length + " of 7 days this week");
  goalRow(host, {
    label: "Said “I don't know” or “you're right”",
    note: "Today, and meant it", done: !!humble[today], extra: dots,
    toggle: (on) => updateWeek({ humble: { [today]: on } }),
  });

  // Daily: hifz, ticked here because it isn't a calendar block
  const hifz = w.hifz || {};
  const hdots = document.createElement("span");
  hdots.className = "goal-dots";
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const dot = document.createElement("i");
    if (hifz[ymd(d)]) dot.className = "on";
    if (ymd(d) === today) dot.classList.add("today");
    hdots.appendChild(dot);
  }
  const hdays = Object.keys(hifz).filter((k) => hifz[k]).length;
  hdots.setAttribute("aria-label", hdays + " of 7 days this week");
  goalRow(host, {
    label: "Hifz today", note: hdays + " of 7 days this week", done: !!hifz[today], extra: hdots,
    toggle: (on) => updateWeek({ hifz: { [today]: on } }),
  });

  // Weekly: meetups
  const meet = Number(w.meetups) || 0;
  const step = document.createElement("span");
  step.className = "goal-step";
  const minus = document.createElement("button");
  minus.type = "button"; minus.textContent = "−"; minus.setAttribute("aria-label", "One fewer meetup");
  minus.disabled = meet === 0;
  minus.addEventListener("click", () => updateWeek({ meetups: Math.max(0, meet - 1) }));
  const plus = document.createElement("button");
  plus.type = "button"; plus.textContent = "+"; plus.setAttribute("aria-label", "Add a meetup");
  plus.addEventListener("click", () => { playTick(); updateWeek({ meetups: meet + 1 }); });
  step.append(minus, plus);
  goalRow(host, {
    label: "Meetups · " + meet + " of " + MEETUP_GOAL,
    note: "Phone away. Ask more than you answer.", done: meet >= MEETUP_GOAL, extra: step,
  });

  // Weekly: one quiet kindness
  goalRow(host, {
    label: "One quiet kindness", note: "Nobody finds out", done: !!w.kindness,
    toggle: (on) => updateWeek({ kindness: on }),
  });

  // Weekly: one project only
  if (growth.editingProject || !growth.project) {
    const form = document.createElement("form");
    form.className = "goal-project";
    const input = document.createElement("input");
    input.type = "text"; input.maxLength = 60; input.value = growth.project;
    input.placeholder = "Your one side project, e.g. Homebase";
    input.setAttribute("aria-label", "Focus project");
    const ok = document.createElement("button");
    ok.type = "submit"; ok.className = "nav-btn"; ok.textContent = "Set";
    form.append(input, ok);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.replace(/\s+/g, " ").trim().slice(0, 60);
      growth.editingProject = false;
      growth.project = name;
      renderGoals();
      saveGrowth(fb.setDoc(growthSettingsRef(), { project: name, updatedAt: Date.now() }, { merge: true }));
    });
    const wrap = document.createElement("div");
    wrap.className = "goal goal-col";
    const l = document.createElement("span");
    l.className = "goal-text";
    l.textContent = "One project only. Everything else is parked.";
    wrap.append(l, form);
    host.appendChild(wrap);
    if (growth.editingProject) setTimeout(() => input.focus(), 0);
  } else {
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "btn-link goal-edit"; edit.textContent = "Change";
    edit.addEventListener("click", () => { growth.editingProject = true; renderGoals(); });
    goalRow(host, {
      label: growth.project + ": weekend block",
      note: "2 hours, once. The rest is parked.", done: !!w.projectDone, extra: edit,
      toggle: (on) => updateWeek({ projectDone: on }),
    });
  }

  // Sunday review
  const rv = document.createElement("div");
  rv.className = "goal-review";
  const btn = document.createElement("button");
  btn.type = "button";
  if (w.review && w.review.at) {
    btn.className = "btn-link";
    btn.textContent = "Review done ✓ · Open";
  } else {
    btn.className = now.getDay() === 0 ? "btn-primary goal-review-btn" : "nav-btn goal-review-btn";
    btn.textContent = now.getDay() === 0 ? "Do your Sunday review" : "Do this week's review";
  }
  btn.addEventListener("click", openReview);
  rv.appendChild(btn);
  host.appendChild(rv);
}

// ---------- Sunday review sheet ----------
function openReview() {
  const r = growth.week.review || {};
  $("review-finished").value = r.finished || "";
  $("review-slip").value = r.slip || "";
  $("review-fix").value = r.fix || "";
  $("review-sub").textContent = r.at ? "Saved " + new Date(r.at).toLocaleDateString("en-US", { weekday: "long" }) + ". Edit if you need to." : "20 minutes. Be honest. Nobody else reads this.";
  $("review-sheet").hidden = false;
  setTimeout(() => $("review-finished").focus(), 50);
}

function closeReview() { $("review-sheet").hidden = true; }

function wireGrowth() {
  $("miss-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const clean = (id, n) => $(id).value.replace(/\s+/g, " ").trim().slice(0, n);
    const course = clean("miss-course", 40), q = clean("miss-q", 300), fix = clean("miss-fix", 300);
    if (!q) { $("miss-q").focus(); return; }
    addMissed(course, q, fix);
    try { localStorage.setItem("hb-miss-course", course); } catch (err) {}
    $("miss-q").value = ""; $("miss-fix").value = "";
    $("miss-q").focus();
    toast("Added. First redo in " + MISS_FIRST_DAYS + " days.");
  });
  try { $("miss-course").value = localStorage.getItem("hb-miss-course") || ""; } catch (e) {}
  $("review-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const review = {
      finished: $("review-finished").value.trim().slice(0, 1000),
      slip: $("review-slip").value.trim().slice(0, 1000),
      fix: $("review-fix").value.replace(/\s+/g, " ").trim().slice(0, 200),
      at: Date.now(),
    };
    if (!review.finished && !review.slip && !review.fix) { $("review-finished").focus(); return; }
    closeReview();
    playTick();
    updateWeek({ review });
    toast(review.fix ? "Saved. Your fix is pinned to This week." : "Review saved.");
  });
  $("review-cancel").addEventListener("click", closeReview);
  $("review-sheet").addEventListener("click", (e) => { if (e.target.id === "review-sheet") closeReview(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("review-sheet").hidden) closeReview(); });
}

// ================================================================ SETTINGS: colours
// The choice is saved on this device (localStorage), so the Mac and the iPhone can differ.
const look = { subject: "", time: "", city: null };
function pref(k, d) { try { return localStorage.getItem("hb-" + k) || d; } catch (e) { return d; } }
function setPref(k, v) { try { localStorage.setItem("hb-" + k, v); } catch (e) {} }

// The subject being studied right now: a running timer wins, then the calendar block happening now.
function currentSubject() {
  const texts = [], now = Date.now();
  if (timer.running) texts.push(timer.running.course, timer.running.label);
  const block = todaysEvents().filter(isBlock).filter((e) => e.startMs <= now && e.endMs > now).pop();
  if (block) texts.push(block.title);
  for (const text of texts) {
    const name = text && theme.matchSubject(text, state.courses);
    if (name) return name;
  }
  return "";
}

// ---- travel mode
function place(k) { try { const p = JSON.parse(pref(k, "null")); return p && isFinite(p.lat) && isFinite(p.lon) ? p : null; } catch (e) { return null; } }
function currentCity() {
  if (pref("travel", "on") !== "on") return null;
  const pick = pref("city", "auto");
  if (theme.CITIES[pick]) return pick;
  return pick === "auto" ? theme.cityNear(place("pos"), place("home")) : null;
}
function locate(saveAs, then) {
  if (!navigator.geolocation) { if (then) then(false); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    // one decimal place is about 10 km: enough to tell cities apart, not an address
    const at = { lat: Math.round(pos.coords.latitude * 10) / 10, lon: Math.round(pos.coords.longitude * 10) / 10, at: Date.now() };
    setPref("pos", JSON.stringify(at));
    if (saveAs === "home") setPref("home", JSON.stringify(at));
    applyLook();
    if (then) then(true);
  }, () => { if (then) then(false); }, { timeout: 15000, maximumAge: 600000 });
}
// Quietly re-check where we are, at most hourly, and only once location has already been allowed
function refreshPlace() {
  if (pref("travel", "on") !== "on" || pref("city", "auto") !== "auto" || !place("home")) return;
  const pos = place("pos");
  if (pos && Date.now() - (pos.at || 0) < 3600000) return;
  if (!navigator.permissions || !navigator.permissions.query) return;
  navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") locate(null); }).catch(() => {});
}

// ---- the drawing behind the page: a city skyline when travelling, else fine line art for the subject
let backdropKey = null;
async function renderBackdrop(city, subject) {
  const host = $("backdrop");
  const key = city ? "city:" + city : pref("art", "on") === "on" ? "art:" + theme.artKey(subject) : "";
  if (!host || key === backdropKey) return;
  backdropKey = key;
  if (!key) { host.textContent = ""; return; }
  try {
    let svg;
    if (city) {
      const sky = (await import("./skylines.js")).SKYLINES[city];
      const paint = (s) => s.replace(/url\(#WIN\)/g, "url(#bd-win)").replace(/fill="GROUNDC"/g, 'style="fill: var(--bg)"');
      svg = '<svg viewBox="0 0 1200 900" preserveAspectRatio="xMidYMax slice" fill="currentColor" style="color: var(--deep)"><defs>' +
        '<linearGradient id="bd-fade" gradientUnits="userSpaceOnUse" x1="0" y1="900" x2="0" y2="0"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#9a9a9a"/><stop offset="1" stop-color="#3a3a3a"/></linearGradient>' +
        '<mask id="bd-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="900"><rect width="1200" height="900" fill="url(#bd-fade)"/></mask>' +
        '<pattern id="bd-win" width="13" height="17" patternUnits="userSpaceOnUse"><rect x="3" y="4" width="5" height="8" style="fill: var(--bg)" fill-opacity=".55"/></pattern></defs>' +
        '<g mask="url(#bd-mask)"><g opacity=".04">' + paint(sky.back) + '</g><g opacity=".085">' + paint(sky.front) + '<rect y="895" width="1200" height="5"/></g></g></svg>';
    } else {
      const art = (await import("./art.js")).ART[key.slice(4)];
      svg = '<svg viewBox="0 0 1200 900" preserveAspectRatio="xMaxYMax slice" style="color: var(--text)"><defs>' +
        '<radialGradient id="bd-fade" gradientUnits="userSpaceOnUse" cx="1100" cy="860" r="900"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#6a6a6a"/><stop offset="1" stop-color="#000"/></radialGradient>' +
        '<mask id="bd-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="900"><rect width="1200" height="900" fill="url(#bd-fade)"/></mask></defs>' +
        '<g mask="url(#bd-mask)" fill="none" stroke="currentColor" stroke-width=".75" stroke-linecap="round" stroke-linejoin="round" opacity=".12">' + art + "</g></svg>";
    }
    if (backdropKey === key) host.innerHTML = svg;
  } catch (e) { console.warn("Couldn't load the background art:", e); backdropKey = null; }
}

function applyLook() {
  const choice = pref("theme", "auto");
  const time = choice === "light" ? "afternoon" : choice === "dark" ? "night" : theme.timeOfDay(new Date());
  const subject = currentSubject(), city = currentCity();
  theme.apply(time, subject ? courseColour(subject) : null, city);
  renderBackdrop(city, subject);
  const changed = subject !== look.subject || time !== look.time || city !== look.city;
  look.subject = subject; look.time = time; look.city = city;
  if (changed && $("view-settings") && !$("view-settings").hidden) renderSettings();
}

function renderSettings() {
  $("set-theme").value = pref("theme", "auto");
  $("set-art").checked = pref("art", "on") === "on";
  $("set-travel").checked = pref("travel", "on") === "on";
  const t = theme.TIMES[look.time];
  $("set-now").textContent = look.city ? "Right now: " + theme.CITIES[look.city].name + " colours (travel mode)"
    : "Right now: " + (t ? t.name : "") + " colours" + (look.subject ? " · " + look.subject : " · no subject on");
  const city = $("set-city");
  if (!city.options.length) {
    [["auto", "By location"], ...Object.entries(theme.CITIES).map(([k, c]) => [k, c.name])].forEach(([v, label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; city.appendChild(o); });
  }
  city.value = theme.CITIES[pref("city", "auto")] ? pref("city", "auto") : "auto";
  $("set-home-note").textContent = place("home") ? "Set (rounded to the nearest town)" : "Not set yet. Travel mode needs it to know when you are away.";
  $("set-home").textContent = place("home") ? "Update to where I am now" : "Set to where I am now";
}

function wireSettings() {
  $("set-theme").addEventListener("change", (e) => { setPref("theme", e.target.value); applyLook(); renderSettings(); });
  $("set-art").addEventListener("change", (e) => { setPref("art", e.target.checked ? "on" : "off"); applyLook(); });
  $("set-travel").addEventListener("change", (e) => { setPref("travel", e.target.checked ? "on" : "off"); applyLook(); renderSettings(); });
  $("set-city").addEventListener("change", (e) => { setPref("city", e.target.value); applyLook(); renderSettings(); });
  $("set-home").addEventListener("click", () => {
    const btn = $("set-home");
    btn.disabled = true; btn.textContent = "Finding…";
    locate("home", (ok) => { btn.disabled = false; renderSettings(); toast(ok ? "Home set." : "Couldn't get your location. Check that it's allowed for Homebase."); });
  });
  $("list-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    if (addList($("list-new").value)) $("list-new").value = "";
  });
  $("kit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    const kit = cleanKit({ title: $("kit-title").value, url: $("kit-url").value, course: $("kit-course").value });
    if (!kit) { toast("Give the kit a name and a link that starts with https://"); return; }
    saveKits([...state.kits, kit]);
    $("kit-title").value = ""; $("kit-url").value = "";
  });
  $("course-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    if (addCourse($("course-new").value)) $("course-new").value = "";
  });
  // A link like ...?subjects=BIO%202000,Chem%201130 opens Settings with those names typed in, ready for you to press Add
  try {
    const url = new URL(location.href), given = url.searchParams.get("subjects");
    if (given) {
      $("course-new").value = given.split(",").map(cleanCourse).filter(Boolean).slice(0, MAX_COURSES).join(", ");
      url.searchParams.delete("subjects");
      history.replaceState(null, "", url.pathname + url.search + "#settings");
      showTab();
    }
    // ...?kits=Name~link~Subject|Name~link~Subject lines kits up in Study, where one press adds them
    const kits = url.searchParams.get("kits");
    if (kits) {
      const items = kits.split("|").map((x) => x.split("~")).map(([title, link, course]) => cleanKit({ title, url: link, course })).filter(Boolean);
      if (items.length) sessionStorage.setItem("hb-kit-import", JSON.stringify(items));
      url.searchParams.delete("kits");
      history.replaceState(null, "", url.pathname + url.search + "#study");
      showTab();
    }
  } catch (e) {}
  applyLook();
  refreshPlace();
}

// ================================================================ JOURNAL
// One private entry a day. The text is encrypted on this device with your passphrase before it is saved (vault.js),
// so it is unreadable online. Stored in users/{uid}/journal/{yyyy-mm-dd}; the passphrase check lives in settings/journal.
const PROMPTS = [
  ["well", "What went well today, and why?"],
  ["differently", "What would I do differently?"],
  ["grateful", "One thing I'm grateful for"],
  ["tomorrow", "Tomorrow's one priority"],
  ["more", "Anything else on my mind"],
];
const journal = { setup: undefined, key: null, docs: new Map(), day: "", shown: "", unsub: null, busy: false };
const journalKeyName = () => "jk:" + (state.user ? state.user.uid : "");
function journalRef(day) { return fb.doc(fb.db, "users", state.user.uid, "journal", day); }
function journalSetupRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "journal"); }
async function startJournal(user) {
  journal.setup = undefined; journal.docs = new Map(); journal.shown = ""; journal.ready = false;
  journal.key = pref(journalKeyName(), "") || null;
  try {
    const snap = await fb.getDoc(journalSetupRef());
    const d = snap.exists() ? snap.data() : null;
    journal.setup = d && d.salt && d.check ? { salt: d.salt, check: d.check } : null;
  } catch (e) { console.warn("Couldn't read the journal setup:", e); journal.setup = "error"; }   // never offer "set a passphrase" on a failed read: that would orphan every entry
  journal.unsub = fb.onSnapshot(fb.collection(fb.db, "users", user.uid, "journal"), (snap) => {
    journal.docs = new Map(snap.docs.map((d) => [d.id, d.data()]));
    const first = !journal.ready;
    journal.ready = true;
    if ($("view-journal").hidden) return;
    if (first) renderJournal(); else renderJournalSide();
  }, (e) => console.warn("Couldn't load journal entries:", e));
  if (!$("view-journal").hidden) renderJournal();
}
function stopJournal() {
  if (journal.unsub) journal.unsub();
  Object.assign(journal, { setup: undefined, key: null, docs: new Map(), shown: "", unsub: null, ready: false });
}
function journalDate(day) { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); }
function passForm(first) {
  const form = document.createElement("form");
  form.className = "journal-lock";
  form.noValidate = true;
  const h = document.createElement("h2"), p = document.createElement("p"), err = document.createElement("p");
  h.textContent = first ? "Set a journal passphrase" : "Unlock your journal";
  p.className = "empty";
  p.textContent = first
    ? "Your entries are locked with this passphrase before they are saved, so nobody else can read them. If you forget it, the entries cannot be recovered, so write it down somewhere safe. You'll enter it once on each device."
    : "Enter your journal passphrase. You only do this once on this device.";
  err.className = "form-error"; err.setAttribute("role", "alert");
  const mkInput = (label) => { const i = document.createElement("input"); i.type = "password"; i.autocomplete = first ? "new-password" : "current-password"; i.placeholder = label; i.setAttribute("aria-label", label); i.maxLength = 200; return i; };
  const a = mkInput("Passphrase"), b = first ? mkInput("Type it again") : null;
  const go = document.createElement("button");
  go.type = "submit"; go.className = "btn-primary"; go.textContent = first ? "Set passphrase" : "Unlock";
  form.append(h, p, a, ...(b ? [b] : []), err, go);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (journal.busy) return;
    err.textContent = "";
    if (first && a.value.length < 8) { err.textContent = "Use at least 8 characters."; return; }
    if (first && a.value !== b.value) { err.textContent = "The two don't match."; return; }
    if (!a.value) return;
    journal.busy = true; go.disabled = true;
    try {
      if (first) {
        const salt = vault.newSalt(), key = await vault.keyFromPassphrase(a.value, salt);
        const check = await vault.seal(key, "homebase");
        await fb.setDoc(journalSetupRef(), { salt, check, createdAt: Date.now() });
        journal.setup = { salt, check }; journal.key = key;
      } else {
        const key = await vault.keyFromPassphrase(a.value, journal.setup.salt);
        try { await vault.open(key, journal.setup.check); } catch (bad) { err.textContent = "That passphrase doesn't match."; return; }
        journal.key = key;
      }
      setPref(journalKeyName(), journal.key);
      journal.shown = "";
      renderJournal();
    } catch (x) { console.error(x); err.textContent = "Something went wrong. Check your connection and try again."; }
    finally { journal.busy = false; go.disabled = false; }
  });
  return form;
}
function renderJournalSide() {
  const side = $("journal-side");
  side.textContent = "";
  if (!journal.key) return;
  const h = document.createElement("h2");
  h.textContent = "Entries";
  side.appendChild(h);
  const today = ymd(new Date());
  const days = [...new Set([today, ...journal.docs.keys()])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 60);
  const ul = document.createElement("ul");
  ul.className = "journal-days";
  days.forEach((d) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button";
    b.textContent = d === today ? "Today" : journalDate(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    b.setAttribute("aria-current", String(d === journal.day));
    if (!journal.docs.has(d)) b.classList.add("is-empty");
    b.addEventListener("click", () => { journal.day = d; journal.shown = ""; renderJournal(); });
    li.appendChild(b); ul.appendChild(li);
  });
  side.appendChild(ul);
  const lock = document.createElement("button");
  lock.type = "button"; lock.className = "btn-link"; lock.textContent = "Lock on this device";
  lock.addEventListener("click", () => { journal.key = null; try { localStorage.removeItem("hb-" + journalKeyName()); } catch (e) {} journal.shown = ""; renderJournal(); });
  side.appendChild(lock);
}
async function renderJournal() {
  const main = $("journal-main");
  if (!journal.day) journal.day = ymd(new Date());
  $("journal-day").textContent = journalDate(journal.day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (!state.user || journal.setup === undefined || !journal.ready) { main.innerHTML = '<p class="empty">Loading…</p>'; $("journal-side").textContent = ""; return; }
  if (journal.setup === "error") { main.innerHTML = '<p class="empty">Couldn\'t load your journal. Check your connection and reload.</p>'; $("journal-side").textContent = ""; return; }
  if (!journal.setup || !journal.key) { main.textContent = ""; main.appendChild(passForm(!journal.setup)); $("journal-side").textContent = ""; return; }
  renderJournalSide();
  if (journal.shown === journal.day) return;        // never redraw the page under what you're typing
  const day = journal.day;
  let entry = {};
  const box = journal.docs.get(day);
  if (box && box.data) {
    try { entry = (await vault.open(journal.key, box)) || {}; }
    catch (e) { main.innerHTML = '<p class="empty">This entry can\'t be opened with the passphrase on this device. Lock and unlock again with the right one.</p>'; return; }
  }
  if (day !== journal.day) return;
  journal.shown = day;
  main.textContent = "";
  const form = document.createElement("form");
  form.className = "journal-entry";
  const fields = {};
  PROMPTS.forEach(([id, label]) => {
    const wrap = document.createElement("label"), t = document.createElement("textarea"), s = document.createElement("span");
    s.textContent = label;
    t.rows = id === "more" ? 5 : 2; t.maxLength = 4000; t.value = (entry.answers && entry.answers[id]) || "";
    wrap.append(s, t); form.appendChild(wrap); fields[id] = t;
  });
  const bar = document.createElement("div"), saveBtn = document.createElement("button"), note = document.createElement("span");
  bar.className = "journal-bar";
  saveBtn.type = "submit"; saveBtn.className = "btn-primary"; saveBtn.textContent = "Save";
  note.className = "journal-note"; note.setAttribute("role", "status");
  note.textContent = box && box.updatedAt ? "Saved " + fmtTime(box.updatedAt) + " · locked with your passphrase" : "Not saved yet";
  bar.append(saveBtn, note); form.appendChild(bar);
  const saveEntry = async () => {
    const answers = Object.fromEntries(PROMPTS.map(([id]) => [id, fields[id].value.trim()]));
    try {
      const sealed = await vault.seal(journal.key, { v: 1, answers });
      const now = Date.now();
      journal.docs.set(day, { ...sealed, updatedAt: now });
      await fb.setDoc(journalRef(day), { ...sealed, updatedAt: now });
      note.textContent = "Saved " + fmtTime(now) + " · locked with your passphrase";
      renderJournalSide();
    } catch (e) { console.error(e); note.textContent = "Couldn't save. Check your connection."; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); saveEntry(); });
  form.addEventListener("change", saveEntry);     // leaving a box saves it
  main.appendChild(form);
}

// ================================================================ START
window.addEventListener("hashchange", showTab);
showTab();
renderHeader();
renderTasks();
scrollToNow(renderTimeline());
renderCalendar();
setInterval(() => { renderHeader(); renderCalendar(); checkStale(); checkWeekRollover(); refreshPlace(); }, 60 * 1000);
wireSignIn();
wireCalendar();
wireCalendarTab();
wireTimer();
wireGrowth();
wireSettings();
startData();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline mode unavailable:", e));
}
