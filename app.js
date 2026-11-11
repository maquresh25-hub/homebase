// Homebase app — v2: shell + sign-in + synced To-Do
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

const START_HOUR = 8;   // timeline starts 8 AM
const END_HOUR = 22;    // and ends 10 PM
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
  let text = " ";
  if (state.status === "ready") {
    const open = openTasks().length;
    if (open > 0) text = open + (open === 1 ? " task" : " tasks");
    else text = state.tasks.length ? "Nothing left to do" : "No tasks yet";
  }
  $("today-summary").textContent = text;
  $("todo-summary").textContent = text;
}

function fmtHour(h) {
  const suffix = h < 12 || h === 24 ? "AM" : "PM";
  return (h % 12 === 0 ? 12 : h % 12) + " " + suffix;
}

function renderTimeline() {
  const tl = $("timeline");
  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hour")) || 56;
  tl.textContent = "";
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const row = document.createElement("div");
    row.className = "hour";
    row.style.top = (h - START_HOUR) * hourPx + 8 + "px";
    const label = document.createElement("span");
    label.textContent = fmtHour(h);
    row.appendChild(label);
    tl.appendChild(row);
  }
  const empty = document.createElement("p");
  empty.className = "tl-empty";
  empty.textContent = "Your calendar isn't connected yet.";
  tl.appendChild(empty);

  const now = new Date();
  const hours = now.getHours() + now.getMinutes() / 60;
  if (hours >= START_HOUR && hours <= END_HOUR) {
    const line = document.createElement("div");
    line.className = "now";
    line.style.top = (hours - START_HOUR) * hourPx + 8 + "px";
    const b = document.createElement("b");
    b.textContent = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    line.appendChild(b);
    tl.appendChild(line);
    return line;
  }
  return null;
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
function playTick() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const t = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.07]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.16, t + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.25);
    });
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
    updateDoc: fsMod.updateDoc,
    onSnapshot: fsMod.onSnapshot,
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
    if (user) startTasks(user);
    else renderTasks();
  });
}

// ================================================================ START
window.addEventListener("hashchange", showTab);
showTab();
renderHeader();
renderTasks();
scrollToNow(renderTimeline());
setInterval(() => { renderHeader(); renderTimeline(); }, 60 * 1000);
wireSignIn();
startData();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline mode unavailable:", e));
}
