// ================================================================ STUDY TIMER
// Tap ▶ on a yellow study block to start; the timer shows at the bottom of the
// sidebar (Mac) or above the tab bar (iPhone) on every screen. Sessions sync
// between devices in users/{uid}/sessions, in the shape the Learning Time
// Tracker spec needs later (start, end, course, topic, method, focus, note).
import { renderCalendar } from "./calendar.js";
import { fb } from "./firebase.js";
import { renderGoals } from "./growth.js";
import { applyLook } from "./look.js";
import { playTick, unlockAudio } from "./sound.js";
import { state } from "./state.js";
import { STATS_DAYS, renderStudy } from "./study.js";
import { save } from "./tasks.js";
import { toast } from "./toast.js";
import { $, addDays, fmtClock, fmtDuration, fmtTime, startOfDay } from "./util.js";

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


export { checkStale, loggedFor, openSessionSheet, startSession, startSessions, stopSession, stopSessions, timer, wireTimer };
