// ---------- Study tab: start a session, stats, and the last week's log ----------
import { openSessionSheet, timer } from "./timer.js";
import { $, addDays, fmtDuration, fmtTime, startOfDay, startOfWeek } from "./util.js";

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


export { STATS_DAYS, doneSessions, renderStudy, studyStreak, sumTime };
