// Homebase app — v4: shell + sign-in + synced To-Do + Google Calendar timeline + week view
// Data lives in Firebase Firestore under users/{uid}/tasks/{taskId}.
// Each task is its own document, so a change on one device never overwrites
// other tasks, and nothing is ever hard-deleted (deleted tasks are flagged).

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
const TABS = ["today", "calendar", "todo", "study", "materials"];
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
  range: null,        // [startMs, endMs] the main copy covers
};
let fb = null;        // loaded Firebase functions + instances
let unsubscribeTasks = null;

// ================================================================ SHELL
function showTab() {
  const hash = location.hash.slice(1);
  const tab = TABS.includes(hash) ? hash : "today";
  TABS.forEach((t) => {
    $("view-" + t).hidden = t !== tab;
    const link = document.querySelector('[data-tab="' + t + '"]');
    link.classList.toggle("active", t === tab);
    if (t === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function renderHeader() {
  $("today-title").textContent = new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "short", day: "numeric",
  });
  renderSummary();
}

// Every number shown must be real and match the screen.
function renderSummary() {
  let taskText = "\u00a0";
  if (state.status === "ready") {
    const open = openTasks().length;
    if (open > 0) taskText = open + (open === 1 ? " task" : " tasks");
    else taskText = state.tasks.length ? "Nothing left to do" : "No tasks yet";
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
  $("today-summary").textContent = parts.length ? parts.join(" · ") : "\u00a0";
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
  renderAllDay(alldayBox, dayEvents.filter((e) => e.allDay), markers);

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
  if (state.calStatus === "error" && !timed.length) emptyMsg("Couldn't reach your calendar. ", "Try again", () => refreshEvents(true));
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
  if (ev.cat !== "study") return block;

  // Study blocks get a play button (no separate study button anywhere else)
  const logged = loggedFor(ev);
  if (logged > 0) {
    const em = document.createElement("em");
    em.className = "logged";
    em.textContent = "✓ " + fmtDuration(logged) + " logged";
    block.appendChild(em);
  }
  const wrap = document.createElement("div");
  wrap.className = "event-wrap";
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
  return wrap;
}

function renderTimeline() {
  return drawDay($("timeline"), $("allday"), new Date(), { emptyText: "Nothing scheduled today. Enjoy the open time." });
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
const openTasks = () => state.tasks.filter((t) => !t.done).sort((a, b) => a.createdAt - b.createdAt);
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

function addTask(raw) {
  const title = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  if (!title) return false;
  const ref = fb.doc(fb.collection(fb.db, "users", state.user.uid, "tasks"));
  const now = Date.now();
  save(fb.setDoc(ref, { title, done: false, deleted: false, createdAt: now, updatedAt: now, doneAt: null }));
  return true;
}

function toggleTask(task) {
  const done = !task.done;
  if (done) playTick();
  save(fb.updateDoc(taskRef(task.id), { done, doneAt: done ? Date.now() : null, updatedAt: Date.now() }));
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

function taskItem(task) {
  const li = document.createElement("li");
  li.className = "task" + (task.done ? " is-done" : "");

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", (task.done ? "Mark not done: " : "Mark done: ") + task.title);
  check.setAttribute("aria-pressed", task.done ? "true" : "false");
  check.addEventListener("click", () => {
    li.classList.add(task.done ? "uncheck-anim" : "check-anim");
    setTimeout(() => toggleTask(task), task.done ? 0 : 260);
  });

  const text = document.createElement("span");
  text.className = "task-title";
  const [name, detail] = splitTitle(task.title);
  text.textContent = name;
  if (detail) {
    const d = document.createElement("span");
    d.className = "detail";
    d.textContent = " " + detail;
    text.appendChild(d);
  }

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.setAttribute("aria-label", "Delete: " + task.title);
  del.textContent = "×";
  del.addEventListener("click", () => deleteTask(task));

  li.append(check, text, del);
  return li;
}

function addForm(placeholder) {
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
    if (addTask(input.value)) input.value = "";
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
  const host = $("todo-full");
  if (state.status === "loading") return skeleton(host);
  if (state.status === "error") return errorBox(host, "Couldn't load your tasks.");
  host.textContent = "";
  const open = openTasks();
  const done = doneTasks();

  if (open.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = done.length ? "All done. Nice work." : "No tasks yet. Type one below and press Return.";
    host.appendChild(p);
  } else {
    const ul = document.createElement("ul");
    ul.className = "tasks";
    open.forEach((t) => ul.appendChild(taskItem(t)));
    host.appendChild(ul);
  }
  host.appendChild(addForm("Add a task"));

  if (done.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "completed-toggle";
    toggle.setAttribute("aria-expanded", String(state.showCompleted));
    toggle.textContent = (state.showCompleted ? "▾ " : "▸ ") + "Completed " + done.length;
    toggle.addEventListener("click", () => { state.showCompleted = !state.showCompleted; renderTodoPage(); });
    host.appendChild(toggle);
    if (state.showCompleted) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      done.forEach((t) => ul.appendChild(taskItem(t)));
      host.appendChild(ul);
    }
  }
}

function renderTasks() {
  renderTodayCard();
  renderTodoPage();
  renderSummary();
}

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
    state.doneEvents = new Set(snap.docs.map((d) => d.data()).filter((d) => d.done).map((d) => d.eventId));
    renderCalendar();
  }, (e) => console.warn("Couldn't load done deadlines:", e));
}

function stopDone() {
  if (unsubscribeDone) unsubscribeDone();
  unsubscribeDone = null;
  state.doneEvents = new Set();
}

function doneRef(eventId) {
  return fb.doc(fb.db, "users", state.user.uid, "doneEvents", encodeURIComponent(eventId).slice(0, 1400));
}

function setEventDone(ev, done) {
  if (!fb || !state.user) return;
  // Update the screen right away; Firestore syncs in the background (and offline).
  if (done) state.doneEvents.add(ev.id); else state.doneEvents.delete(ev.id);
  renderCalendar();
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
    if (user) { startTasks(user); startDone(user); startSessions(user); loadCalendarSettings(user); }
    else {
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

function eventsForDay(date) {
  const s = startOfDay(date).getTime(), e = addDays(startOfDay(date), 1).getTime();
  // Hide deadlines marked done, and duplicates that come from two calendars.
  const list = state.events.filter((ev) => ev.startMs < e && ev.endMs > s && !state.doneEvents.has(ev.id));
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
  items.forEach(({ ev, text }) => {
    const chip = document.createElement("button");
    chip.type = "button";
    // Quizzes and deadlines: tap to mark done and hide them. Everything else: tap for details.
    const doable = ev.cat === "due";
    chip.className = "chip cat-" + ev.cat + (doable ? " chip-done-able" : "");
    if (doable) {
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
    box.appendChild(chip);
  });
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
}

// ================================================================ CALENDAR TAB
// Mac: a week grid like Apple Calendar. iPhone: a week strip with the chosen day below.
const narrow = window.matchMedia("(max-width: 820px)");
const cal = {
  weekStart: startOfWeek(new Date()),
  selected: startOfDay(new Date()),
  cache: new Map(),       // weekStart ms -> events fetched for weeks outside the main range
  loadingWeeks: new Set(),
};

function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; } // Sunday
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();

// Events for a week: from the main copy if it covers that week, otherwise fetched on demand
function weekEvents(weekStart) {
  const s = weekStart.getTime(), e = addDays(weekStart, 7).getTime();
  if (state.range && s >= state.range[0] && e <= state.range[1]) return { events: state.events, loading: false };
  if (cal.cache.has(s)) return { events: cal.cache.get(s), loading: false };
  if (state.calUrl && !cal.loadingWeeks.has(s)) fetchWeek(weekStart);
  return { events: [], loading: !!state.calUrl };
}

async function fetchWeek(weekStart) {
  const s = weekStart.getTime();
  cal.loadingWeeks.add(s);
  try {
    const data = await fetchCalendar(ymd(weekStart), ymd(addDays(weekStart, 7)));
    cal.cache.set(s, normalize(data.events));
  } catch (e) {
    console.warn("Week fetch failed:", e);
    toast("Couldn't load that week. Check your connection.");
    cal.cache.set(s, []);
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
  $("cal-title").textContent = mid.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  let status = " ";
  if (state.calStatus === "ready" && state.eventsAt) status = "Updated " + fmtTime(state.eventsAt);
  else if (state.calStatus === "loading") status = "Updating…";
  else if (state.calStatus === "error") status = "Couldn't reach your calendar";
  $("cal-status").textContent = status;
  if ($("cal-views").hidden) return;

  const { events, loading } = weekEvents(ws);
  const prev = state.events;
  state.events = events;            // drawing helpers read state.events; restore right after
  try {
    if (narrow.matches) renderPhoneWeek(loading);
    else renderWeekGrid(loading);
  } finally {
    state.events = prev;
  }
}

function renderPhoneWeek(loading) {
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
  const line = drawDay($("day-timeline"), $("day-allday"), cal.selected, { loading, emptyText: "Nothing scheduled." });
  if (line && !cal.scrolledPhone) { scrollToNow(line); cal.scrolledPhone = true; }
}

function renderWeekGrid(loading) {
  $("phone-week").hidden = true;
  const host = $("week-grid");
  host.hidden = false;
  host.textContent = "";
  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
  const days = [...Array(7)].map((_, i) => addDays(cal.weekStart, i));
  const perDay = days.map((d) => eventsForDay(d));

  // One shared hour range for the week
  let startH = DEFAULT_START, endH = DEFAULT_END;
  perDay.forEach((list, i) => {
    const [a, b] = hourRange(list.filter(isBlock), days[i].getTime());
    startH = Math.min(startH, a); endH = Math.max(endH, b);
  });
  const y = (h) => (h - startH) * hourPx + 8;

  // Header: day names and dates
  const head = document.createElement("div");
  head.className = "wk-head";
  head.appendChild(document.createElement("div"));
  days.forEach((d) => {
    const c = document.createElement("div");
    c.className = "wk-day" + (sameDay(d, new Date()) ? " is-today" : "");
    const dow = document.createElement("span");
    dow.textContent = d.toLocaleDateString("en-US", { weekday: "short" });
    const num = document.createElement("b");
    num.textContent = d.getDate();
    c.append(dow, num);
    head.appendChild(c);
  });
  host.appendChild(head);

  // All-day and deadline chips, per day
  const chipsByDay = perDay.map((list) => list.filter((e) => e.allDay || !isBlock(e)));
  if (chipsByDay.some((l) => l.length)) {
    const row = document.createElement("div");
    row.className = "wk-allday";
    row.appendChild(document.createElement("div"));
    chipsByDay.forEach((list) => {
      const cell = document.createElement("div");
      list.forEach((e) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip cat-" + e.cat;
        chip.textContent = e.allDay ? e.title : e.title + " · " + fmtTime(e.startMs);
        chip.addEventListener("click", () => openEventSheet(e));
        cell.appendChild(chip);
      });
      row.appendChild(cell);
    });
    host.appendChild(row);
  }

  const scroller = document.createElement("div");
  scroller.className = "wk-scroll";
  const body = document.createElement("div");
  body.className = "wk-body";
  body.style.height = (endH - startH) * hourPx + 16 + "px";
  for (let h = startH; h <= endH; h++) {
    const row = document.createElement("div");
    row.className = "hour";
    row.style.top = y(h) + "px";
    const label = document.createElement("span");
    label.textContent = h === 24 ? "12 AM" : fmtHour(h);
    row.appendChild(label);
    body.appendChild(row);
  }
  let nowLine = null;
  days.forEach((d, i) => {
    const col = document.createElement("div");
    col.className = "wk-col" + (sameDay(d, new Date()) ? " is-today" : "");
    col.style.left = "calc(64px + (100% - 64px) * " + i / 7 + ")";
    col.style.width = "calc((100% - 64px) / 7)";
    const dayStart = d.getTime();
    layoutColumns(perDay[i].filter(isBlock)).forEach(({ ev, col: c, cols }) => {
      const s = Math.max(startH, (ev.startMs - dayStart) / 3600000);
      const en = Math.min(endH, (ev.endMs - dayStart) / 3600000);
      const block = eventBlock(ev, (en - s) * hourPx);
      block.style.top = y(s) + 1 + "px";
      block.style.left = "calc(" + (100 * c / cols) + "% + 2px)";
      block.style.width = "calc(" + (100 / cols) + "% - 4px)";
      col.appendChild(block);
    });
    if (sameDay(d, new Date())) {
      const now = new Date();
      const hours = now.getHours() + now.getMinutes() / 60;
      if (hours >= startH && hours <= endH) {
        nowLine = document.createElement("div");
        nowLine.className = "wk-now";
        nowLine.style.top = y(hours) + "px";
        col.appendChild(nowLine);
      }
    }
    body.appendChild(col);
  });
  if (loading) {
    const p = document.createElement("p");
    p.className = "tl-empty";
    p.textContent = "Loading this week…";
    body.appendChild(p);
  }
  scroller.appendChild(body);
  host.appendChild(scroller);
  // Open at 8 AM so mornings are visible; later in the day, keep the "now" line in view
  requestAnimationFrame(() => {
    let target = y(Math.max(startH, 8)) - 8;
    if (nowLine && nowLine.offsetTop > target + scroller.clientHeight - 80) target = nowLine.offsetTop - scroller.clientHeight / 2;
    scroller.scrollTop = Math.max(0, target);
  });
}

// ---------- Event details (opens on tap) ----------
function openEventSheet(ev) {
  const sheet = $("event-sheet");
  $("sheet-title").textContent = ev.title;
  $("sheet-dot").className = "dot cat-" + ev.cat;
  const day = new Date(ev.startMs).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  $("sheet-when").textContent = ev.allDay ? day + " · All day"
    : day + " · " + fmtTime(ev.startMs) + (ev.endMs > ev.startMs ? " – " + fmtTime(ev.endMs) : "");
  $("sheet-cal").textContent = ev.calendar ? "From " + ev.calendar : "";
  $("sheet-loc").textContent = ev.location || "";
  $("sheet-loc").hidden = !ev.location;
  sheet.hidden = false;
  $("sheet-close").focus();
}
function closeEventSheet() { $("event-sheet").hidden = true; }

function wireCalendarTab() {
  const go = (days) => { cal.weekStart = addDays(cal.weekStart, days); cal.selected = addDays(cal.selected, days); renderCalendarTab(); };
  $("wk-prev").addEventListener("click", () => go(-7));
  $("wk-next").addEventListener("click", () => go(7));
  $("wk-today").addEventListener("click", () => {
    cal.weekStart = startOfWeek(new Date()); cal.selected = startOfDay(new Date()); renderCalendarTab();
  });
  narrow.addEventListener("change", renderCalendarTab);
  $("cal-settings").addEventListener("click", () => {
    cal.editing = true; renderCalendarTab(); $("cal-url").focus();
  });
  $("sheet-close").addEventListener("click", closeEventSheet);
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

async function fetchCalendar(from, to, url) {
  const res = await fetch((url || state.calUrl) + "&from=" + from + "&to=" + to, { cache: "no-store" });
  const data = await res.json();
  if (!data || data.ok !== true || !Array.isArray(data.events)) throw new Error((data && data.error) || "bad response");
  return data;
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
const STALE_MS = 4 * 3600000;   // a timer running this long probably wasn't stopped
const timer = { running: null, recent: [], unsubRunning: null, unsubRecent: null, tick: null, staleAsked: new Set() };

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
  return timer.recent.filter((s) => s.eventId === ev.id && s.status === "done" && s.end)
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
    label: ev.title, course: guessCourse(ev.title), topic: null, method: null,
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
  if (!s) return;
  $("timer-label").textContent = s.course || s.label;
  const update = () => { $("timer-time").textContent = fmtClock(Date.now() - s.start); };
  update();
  timer.tick = setInterval(update, 1000);
  if (Date.now() - s.start > STALE_MS && !timer.staleAsked.has(s.id)) { timer.staleAsked.add(s.id); openStaleSheet(s); }
}

// ---------- After stopping: optional focus rating and note ----------
let sheetSession = null;
function openSessionSheet(s) {
  sheetSession = s;
  $("session-title").textContent = "Logged " + fmtDuration(s.end - s.start);
  $("session-sub").textContent = s.label + " · " + fmtTime(s.start) + " – " + fmtTime(s.end);
  $("session-note").value = s.note || "";
  document.querySelectorAll("#focus-row button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === s.focus)));
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
  if (focus !== s.focus || note !== (s.note || "")) {
    save(fb.updateDoc(sessionRef(s.id), { focus, note, updatedAt: Date.now() }));
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
  toast("Session deleted", "Undo", () => {
    save(fb.updateDoc(sessionRef(s.id), { status: "done", updatedAt: Date.now() }));
  });
}

// ---------- Forgot to stop? Ask, never log silently ----------
let staleSession = null;
function openStaleSheet(s) {
  staleSession = s;
  const startTxt = new Date(s.start).toLocaleDateString("en-US", { weekday: "short" }) + " " + fmtTime(s.start);
  $("stale-text").textContent = "Your " + (s.course || s.label) + " timer has been running since " + startTxt +
    " (" + fmtDuration(Date.now() - s.start) + "). When did you stop?";
  const endBtn = $("stale-end");
  const canUseEnd = s.eventEnd && s.eventEnd > s.start && s.eventEnd < Date.now();
  endBtn.hidden = !canUseEnd;
  if (canUseEnd) endBtn.textContent = "When the block ended (" + fmtTime(s.eventEnd) + ")";
  const d = new Date(Math.min(Date.now(), s.start + 3600000));
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
    renderTimer();
    renderCalendar();
  }, (e) => console.warn("Couldn't load the timer:", e));
  const since = addDays(startOfDay(new Date()), -7).getTime();
  timer.unsubRecent = fb.onSnapshot(fb.query(col, fb.where("start", ">=", since)), (snap) => {
    timer.recent = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status === "done");
    renderCalendar();
  }, (e) => console.warn("Couldn't load study sessions:", e));
}

function stopSessions() {
  if (timer.unsubRunning) timer.unsubRunning();
  if (timer.unsubRecent) timer.unsubRecent();
  timer.unsubRunning = timer.unsubRecent = null;
  timer.running = null;
  timer.recent = [];
  renderTimer();
}

function wireTimer() {
  $("timer-stop").addEventListener("click", stopSession);
  $("session-save").addEventListener("click", () => closeSessionSheet(true));
  $("session-delete").addEventListener("click", deleteSheetSession);
  $("session-sheet").addEventListener("click", (e) => { if (e.target.id === "session-sheet") closeSessionSheet(true); });
  document.querySelectorAll("#focus-row button").forEach((b) => b.addEventListener("click", () => {
    const on = b.getAttribute("aria-pressed") !== "true";
    document.querySelectorAll("#focus-row button").forEach((x) => x.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", String(on));
  }));
  $("stale-end").addEventListener("click", () => resolveStale(staleSession && staleSession.eventEnd));
  $("stale-now").addEventListener("click", () => resolveStale(Date.now()));
  $("stale-later").addEventListener("click", () => { $("stale-sheet").hidden = true; staleSession = null; });
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

// ================================================================ START
window.addEventListener("hashchange", showTab);
showTab();
renderHeader();
renderTasks();
scrollToNow(renderTimeline());
renderCalendar();
setInterval(() => { renderHeader(); renderCalendar(); }, 60 * 1000);
wireSignIn();
wireCalendar();
wireCalendarTab();
wireTimer();
startData();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline mode unavailable:", e));
}
