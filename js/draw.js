import { openEventSheet } from "./calendar-tab.js";
import { eventsForDay, layoutColumns, refreshEvents, renderAllDay } from "./calendar.js";
import { playTick } from "./sound.js";
import { DEFAULT_END, DEFAULT_START, state } from "./state.js";
import { setEventDone } from "./sync.js";
import { tasksDue } from "./tasks.js";
import { loggedFor, startSession, stopSession, timer } from "./timer.js";
import { fmtDuration, fmtHour, fmtTime, startOfDay, ymd } from "./util.js";


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


export { drawDay, eventBlock, isBlock };
