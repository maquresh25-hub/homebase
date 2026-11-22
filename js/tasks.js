// ================================================================ TASKS (data)
import { cleanCourse } from "./courses.js";
import { fb } from "./firebase.js";
import { playTick } from "./sound.js";
import { MAX_TITLE, state } from "./state.js";
import { toast } from "./toast.js";
import { isEditingTask, renderTasks, renderTodayCard, renderTodoPage } from "./todo.js";
import { $, pref, setPref, startOfDay, ymd } from "./util.js";

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


export { DEFAULT_LISTS, IDEAS, PRIORITIES, addList, addTask, byPriority, deleteTask, doneTasks, doneToday, dueLabel, lastList, listOf, loadLists, openIdeas, openTasks, renameTask, renderLists, save, setTaskCourse, setTaskDue, setTaskList, setTaskMins, setTaskPriority, taskRef, tasksDue, toggleTask };
