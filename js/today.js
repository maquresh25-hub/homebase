import { openEventSheet, poolFor } from "./calendar-tab.js";
import { daysLeftText, eventsForDay, nextExam, refreshEvents, renderAllDay, todaysEvents } from "./calendar.js";
import { eventBlock, isBlock } from "./draw.js";
import { applyLook, look } from "./look.js";
import { state } from "./state.js";
import { doneSessions, studyStreak, sumTime } from "./study.js";
import { IDEAS, doneToday, openIdeas, openTasks, tasksDue } from "./tasks.js";
import { renderTodoPage } from "./todo.js";
import { $, addDays, fmtDuration, fmtTime, setPref, startOfDay } from "./util.js";


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


export { renderNow, renderSummary, renderTimeline, renderWindDown, scrollToNow };
