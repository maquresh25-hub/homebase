// ================================================================ CAMPUS EVENTS
// Events for the next two weeks, picked by Muhammad's assistant (the Monday 8 AM digest) and saved in
// users/{uid}/campusEvents/{id}. Homebase only reads them: nothing here ever writes to Firestore.
// The Calendar tab lists them (renderEventsSection); Today shows a short "This week's events" card
// (renderWeekEventsCard). If the digest never runs, both simply show their empty state.
//
// Schema of users/{uid}/campusEvents/{id}:
//   { weekKey: "YYYY-MM-DD" (Monday), title, start, end (ISO 8601 with ET offset, e.g. "2026-11-23T18:00:00-05:00"),
//     place, signupUrl, source, rank: 1|2|3|null (top picks), broadening: bool, meetPeople: bool,
//     conflict: string|null (e.g. "night before BIO exam"), halalNote, createdAt }
//
// Docs without a valid start are skipped. A date-only start ("2026-11-23") is read as an all-day event.
import { fb } from "./firebase.js";
import { downloadIcs } from "./ics.js";
import { overlapsProtected } from "./protected.js";
import { state } from "./state.js";
import { toast } from "./toast.js";
import { $, addDays, fmtTime, sameDay, startOfDay } from "./util.js";

const WINDOW_DAYS = 14;          // the Calendar tab shows now → +14 days
const WEEK_CARD_MAX = 3;         // lines on the Today card
const HOUR = 3600000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const campus = { status: "none", items: [] };   // none (signed out) | loading | ready | error
let unsubscribeCampus = null;

// ---------------------------------------------------------------- data
function text(v, n) { return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : ""; }
function safeUrl(v) {
  try { const u = new URL(String(v || "")); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; } catch (e) { return ""; }
}
// ISO string (with or without offset), date-only string, Firestore Timestamp, Date or ms -> { ms, dateOnly } or null
function parseWhen(v) {
  if (v && typeof v.toMillis === "function") {
    const t = v.toMillis();
    return isFinite(t) ? { ms: t, dateOnly: false } : null;
  }
  if (v instanceof Date) return isFinite(v.getTime()) ? { ms: v.getTime(), dateOnly: false } : null;
  if (typeof v === "number") return isFinite(v) ? { ms: v, dateOnly: false } : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (DATE_ONLY.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const t = new Date(y, m - 1, d).getTime();   // local midnight, not UTC
    return isFinite(t) ? { ms: t, dateOnly: true } : null;
  }
  const t = Date.parse(s);
  return isFinite(t) ? { ms: t, dateOnly: false } : null;
}
// Remote data is checked and trimmed before it reaches the screen
function clean(id, d) {
  if (!d || typeof d !== "object" || d.deleted === true) return null;
  const s = parseWhen(d.start);
  if (!s) return null;
  const e = parseWhen(d.end);
  const allDay = s.dateOnly;
  let end = e && e.ms > s.ms ? e.ms : null;
  if (allDay && !end) end = addDays(new Date(s.ms), 1).getTime();
  const rank = Number(d.rank);
  return {
    id: String(id),
    title: text(d.title, 160) || "Campus event",
    start: s.ms, end, allDay,
    place: text(d.place, 160),
    signupUrl: safeUrl(d.signupUrl),
    source: text(d.source, 80),
    rank: rank === 1 || rank === 2 || rank === 3 ? rank : null,
    broadening: d.broadening === true,
    meetPeople: d.meetPeople === true,
    conflict: text(d.conflict, 200) || null,
    halalNote: text(d.halalNote, 200),
  };
}
// No end given: treat it as an hour long
function effEnd(ev) { return ev.end || ev.start + HOUR; }

function startCampusEvents(user) {
  stopCampusEvents();
  campus.status = "loading";
  renderEventsSection();
  renderWeekEventsCard();
  const col = fb.collection(fb.db, "users", user.uid, "campusEvents");
  unsubscribeCampus = fb.onSnapshot(col, (snap) => {
    campus.items = snap.docs.map((d) => clean(d.id, d.data())).filter(Boolean);
    campus.status = "ready";
    renderEventsSection();
    renderWeekEventsCard();
  }, (e) => {
    console.warn("Couldn't load campus events:", e);
    campus.items = [];
    campus.status = "error";
    renderEventsSection();
    renderWeekEventsCard();
  });
}
function stopCampusEvents() {
  if (unsubscribeCampus) unsubscribeCampus();
  unsubscribeCampus = null;
  campus.items = [];
  campus.status = "none";
}

// ---------------------------------------------------------------- order and windows
// Top picks (by rank), then broadening picks, then the rest; each group by start time
function group(ev) { return ev.rank ? 0 : ev.broadening ? 1 : 2; }
function byPriority(a, b) {
  return group(a) - group(b) || (a.rank && b.rank ? a.rank - b.rank : 0) || a.start - b.start;
}
// Events still in progress count as upcoming
function between(from, to) {
  return campus.items.filter((ev) => effEnd(ev) > from && ev.start < to).sort(byPriority);
}
function upcoming() {
  const now = Date.now();
  return between(now, addDays(new Date(now), WINDOW_DAYS).getTime());
}
// Monday to Sunday of the current week; on Sunday, the week ahead (the Monday digest's week)
function thisWeek() {
  const today = startOfDay(new Date());
  const monday = today.getDay() === 0 ? addDays(today, 1) : addDays(today, -((today.getDay() + 6) % 7));
  return between(Date.now(), addDays(monday, 7).getTime());
}

// ---------------------------------------------------------------- wording
function dayWord(ms) {
  const diff = Math.round((startOfDay(new Date(ms)) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function whenText(ev) {
  const day = dayWord(ev.start);
  if (ev.allDay) return day + " · All day";
  if (!ev.end) return day + " · " + fmtTime(ev.start);
  const endDay = sameDay(new Date(ev.start), new Date(ev.end)) ? "" : dayWord(ev.end) + " ";
  return day + " · " + fmtTime(ev.start) + " – " + endDay + fmtTime(ev.end);
}
function shortWhen(ev) {
  const now = Date.now();
  if (ev.start <= now && effEnd(ev) > now) return "Now";
  const diff = Math.round((startOfDay(new Date(ev.start)) - startOfDay(new Date())) / 86400000);
  const day = diff === 0 ? "Today" : diff === 1 ? "Tmrw" : new Date(ev.start).toLocaleDateString("en-US", { weekday: "short" });
  return ev.allDay ? day : day + " " + fmtTime(ev.start);
}
function inProgress(ev) { const now = Date.now(); return ev.start <= now && effEnd(ev) > now; }
// Quiet note when an event lands on one of his protected blocks (all-day items are left alone)
function protectedClash(ev) {
  if (ev.allDay) return null;
  return overlapsProtected(ev.start, effEnd(ev), state.events || []);
}

// ---------------------------------------------------------------- render helpers
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function signedIn() { return !!(state.user && fb); }

function addToCalendar(ev) {
  const description = [
    ev.conflict ? "Heads up: " + ev.conflict : "",
    ev.halalNote ? "Halal: " + ev.halalNote : "",
    ev.signupUrl ? "Sign up / details: " + ev.signupUrl : "",
    ev.source ? "From " + ev.source : "",
  ].filter(Boolean).join("\n");
  const ok = downloadIcs({
    title: ev.title, start: ev.start, end: effEnd(ev),
    location: ev.place, url: ev.signupUrl, description,
    uid: "campus-" + ev.id + "@homebase",
  }, ev.title);
  toast(ok ? "Calendar file downloaded. Open it to add the event." : "Couldn't make the calendar file.");
}

function eventItem(ev) {
  const li = el("li", "ev-item" + (ev.rank ? " is-top" : ""));
  const when = el("p", "ev-when", whenText(ev));
  if (inProgress(ev)) when.appendChild(el("span", "ev-now", " · Happening now"));
  li.append(when, el("h3", "ev-title", ev.title));
  if (ev.place) li.appendChild(el("p", "ev-place", ev.place));

  const tags = [];
  if (ev.rank) tags.push("Top pick #" + ev.rank);
  if (ev.broadening) tags.push("Something new");
  if (ev.meetPeople) tags.push("Good for meeting people");
  if (tags.length) {
    const row = el("div", "disc-tags");
    tags.forEach((t, i) => row.appendChild(el("span", "disc-tag" + (ev.rank && i === 0 ? " ev-tag-top" : ""), t)));
    li.appendChild(row);
  }
  if (ev.conflict) li.appendChild(el("p", "ev-warn", "Heads up: " + ev.conflict));
  const clash = protectedClash(ev);
  if (clash) li.appendChild(el("p", "disc-note", "Overlaps your " + clash + (/time$/i.test(clash) ? "." : " time.")));
  if (ev.halalNote) li.appendChild(el("p", "disc-note", "Halal: " + ev.halalNote));

  const actions = el("div", "ev-actions");
  if (ev.signupUrl) {
    const a = el("a", "", "Sign up / details");
    a.href = ev.signupUrl; a.target = "_blank"; a.rel = "noopener";
    actions.appendChild(a);
  }
  const add = el("button", "nav-btn", "Add to calendar");
  add.type = "button";
  add.addEventListener("click", () => addToCalendar(ev));
  actions.appendChild(add);
  li.appendChild(actions);
  if (ev.source) li.appendChild(el("p", "ev-source", "From " + ev.source));
  return li;
}

// ---------------------------------------------------------------- Calendar tab
function renderEventsSection() {
  const host = $("events-list");
  if (!host) return;
  const sub = $("events-sub");
  host.textContent = "";
  if (sub) { sub.hidden = true; sub.textContent = ""; }
  if (!signedIn()) { host.appendChild(el("p", "empty", "Sign in to see campus events.")); return; }
  if (campus.status === "loading" || campus.status === "none") { host.appendChild(el("p", "empty", "Loading events…")); return; }
  if (campus.status === "error") { host.appendChild(el("p", "empty", "Couldn't load campus events right now.")); return; }
  if (!campus.items.length) { host.appendChild(el("p", "empty", "No campus events saved yet. Your Monday digest adds them here.")); return; }
  const list = upcoming();
  if (!list.length) { host.appendChild(el("p", "empty", "Nothing coming up in the next two weeks. Your Monday digest adds more.")); return; }
  if (sub) {
    sub.textContent = list.length + (list.length === 1 ? " event" : " events") + " in the next two weeks";
    sub.hidden = false;
  }
  const groups = [0, 1, 2].map((g) => list.filter((ev) => group(ev) === g)).filter((g) => g.length);
  const names = groups.length === 1 ? ["Top picks", "Something new", "Coming up"] : ["Top picks", "Something new", "Also coming up"];
  groups.forEach((items) => {
    host.appendChild(el("h3", "ev-group", names[group(items[0])]));
    const ul = el("ul", "ev-list");
    items.forEach((ev) => ul.appendChild(eventItem(ev)));
    host.appendChild(ul);
  });
}

// ---------------------------------------------------------------- Today card
// quiet: a periodic redraw that leaves the card alone while focus is inside it
function renderWeekEventsCard(quiet) {
  const card = $("week-events-card"), body = $("week-events-body");
  if (!card || !body) return;
  if (quiet === true && card.contains(document.activeElement)) return;
  const items = signedIn() && campus.status === "ready" ? thisWeek() : [];
  card.hidden = items.length === 0;
  body.textContent = "";
  if (!items.length) return;
  const ul = el("ul", "wev-list");
  items.slice(0, WEEK_CARD_MAX).forEach((ev) => {
    const li = el("li");
    const dot = el("span", "wev-dot" + (ev.conflict ? " is-warn" : ""));
    dot.setAttribute("aria-hidden", "true");
    if (ev.conflict) dot.title = "Heads up: " + ev.conflict;
    li.appendChild(dot);
    li.appendChild(el("span", "wev-title", ev.title));
    if (ev.conflict) li.appendChild(el("span", "sr-only", " (heads up: " + ev.conflict + ")"));
    li.appendChild(el("span", "wev-when", shortWhen(ev)));
    ul.appendChild(li);
  });
  body.appendChild(ul);
  const foot = el("p", "wev-foot");
  foot.appendChild(el("span", "", items.length > WEEK_CARD_MAX ? "+" + (items.length - WEEK_CARD_MAX) + " more this week" : ""));
  const all = el("a", "", "See all");
  all.href = "#calendar";
  foot.appendChild(all);
  body.appendChild(foot);
}

export { renderEventsSection, renderWeekEventsCard, startCampusEvents, stopCampusEvents };
