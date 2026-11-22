import { showSignIn } from "./auth.js";
import { loadCalendarSettings, renderCalendar } from "./calendar.js";
import { loadCourses, renderCourses } from "./courses.js";
import { renderDiscover, startDiscover, stopDiscover } from "./discover.js";
import { renderEventsSection, renderWeekEventsCard, startCampusEvents, stopCampusEvents } from "./events.js";
import { fb, loadFirebase } from "./firebase.js";
import { startGrowth, stopGrowth } from "./growth.js";
import { startJournal, stopJournal } from "./journal.js";
import { loadKitLinks, renderKits } from "./kits.js";
import { renderScreenTimeCard, startScreenTime, stopScreenTime } from "./screentime.js";
import { playTick } from "./sound.js";
import { state } from "./state.js";
import { DEFAULT_LISTS, loadLists, renderLists } from "./tasks.js";
import { startSessions, stopSessions } from "./timer.js";
import { toast } from "./toast.js";
import { isEditingTask, renderTasks, renderTodoPage } from "./todo.js";
import { $ } from "./util.js";

let unsubscribeTasks = null;

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
    stopDiscover();
    stopCampusEvents();
    if (user) { startTasks(user); startDone(user); startSessions(user); startGrowth(user); loadCalendarSettings(user); loadKitLinks(); loadCourses(); loadLists(); startJournal(user); startScreenTime(user); startDiscover(user); startCampusEvents(user); }
    else {
      renderDiscover();
      renderEventsSection(); renderWeekEventsCard();
      state.kitLinks = {};
      state.courses = []; state.courseColors = {}; renderCourses();
      state.lists = DEFAULT_LISTS; state.kits = []; renderLists(); renderKits(); stopJournal(); stopScreenTime();
      state.screenTime = {}; renderScreenTimeCard();
      renderTasks();
      state.calUrl = null; state.events = []; state.calStatus = "none"; renderCalendar();
    }
  });
}


export { markEventDone, setEventDone, startData };
