// ================================================================ GROWTH (v17)
// Weekly goals, missed-questions bank and the Sunday review.
// Data: users/{uid}/growth/{weekStart yyyy-mm-dd} (one doc per week),
//       users/{uid}/missed/{id} (one doc per question), users/{uid}/settings/growth (focus project).
import { fb } from "./firebase.js";
import { playTick } from "./sound.js";
import { state } from "./state.js";
import { doneSessions, sumTime } from "./study.js";
import { toast } from "./toast.js";
import { $, addDays, startOfDay, startOfWeek, ymd } from "./util.js";

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


export { checkWeekRollover, renderGoals, renderMissed, startGrowth, stopGrowth, wireGrowth };
