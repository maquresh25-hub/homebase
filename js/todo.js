import { openEventSheet } from "./calendar-tab.js";
import { dedupe, drawingCalendar, renderCalendar } from "./calendar.js";
import { courseColour } from "./courses.js";
import { playTick } from "./sound.js";
import { MAX_TITLE, TODAY_LIMIT, state } from "./state.js";
import { markEventDone, setEventDone } from "./sync.js";
import { IDEAS, PRIORITIES, addTask, byPriority, deleteTask, doneTasks, doneToday, dueLabel, lastList, listOf, openTasks, renameTask, setTaskCourse, setTaskDue, setTaskList, setTaskMins, setTaskPriority, toggleTask } from "./tasks.js";
import { toast } from "./toast.js";
import { renderSummary } from "./today.js";
import { $, addDays, fmtTime, pref, setPref, startOfDay, ymd } from "./util.js";

function todoFilter() { try { return localStorage.getItem("hb-todo-course") || ""; } catch (e) { return ""; } }
// ================================================================ TASKS (view)
// "Read BIO (Ch. 7–8)" -> name "Read BIO", detail "(Ch. 7–8)" shown in grey
function splitTitle(title) {
  const m = title.match(/^(.*?)\s*(\([^()]*\))\s*$/);
  return m && m[1] ? [m[1], m[2]] : [title, ""];
}

// full = the To-Do tab, where there's room for the priority flag and the subject picker
function taskItem(task, full) {
  const li = document.createElement("li");
  const pri = task.priority === "high" || task.priority === "low" ? task.priority : "normal";
  li.className = "task" + (task.done ? " is-done" : "") + (pri !== "normal" && !task.done ? " pri-" + pri : "");

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", (task.done ? "Mark not done: " : "Mark done: ") + task.title);
  check.setAttribute("aria-pressed", task.done ? "true" : "false");
  check.addEventListener("click", () => {
    if (task.done) { toggleTask(task); return; }
    li.classList.add("check-anim");
    // Let the tick land, then fold the row away before the list redraws
    setTimeout(() => {
      li.style.height = li.offsetHeight + "px";
      void li.offsetHeight;
      li.classList.add("collapsing");
      setTimeout(() => toggleTask(task), 190);
    }, 260);
  });

  // Tap the name to rename the task
  const text = document.createElement("span");
  text.className = "task-title";
  text.tabIndex = 0;
  text.setAttribute("role", "button");
  text.setAttribute("aria-label", "Rename: " + task.title);
  const [name, detail] = splitTitle(task.title);
  text.textContent = name;
  if (detail) {
    const d = document.createElement("span");
    d.className = "detail";
    d.textContent = " " + detail;
    text.appendChild(d);
  }
  text.addEventListener("click", () => editTask(task, text));
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); editTask(task, text); }
  });

  // Due date: tap to pick one. Tasks with a date also show on the calendar that day.
  const dueWrap = document.createElement("span");
  const overdue = !!task.due && !task.done && task.due < ymd(new Date());
  dueWrap.className = "due" + (task.due ? " has-due" : "") + (overdue ? " is-over" : "");
  const dueText = document.createElement("span");
  dueText.setAttribute("aria-hidden", "true");
  if (task.due) dueText.textContent = dueLabel(task.due);
  else dueText.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
  const picker = document.createElement("input");
  picker.type = "date";
  picker.className = "due-input";
  picker.value = task.due || "";
  picker.setAttribute("aria-label", (task.due ? "Due " + dueLabel(task.due) + ". Change" : "Add a due date") + ": " + task.title);
  picker.addEventListener("click", () => { try { picker.showPicker(); } catch (e) { /* the tap itself opens it */ } });
  picker.addEventListener("change", () => { setTaskDue(task, picker.value); picker.blur(); });
  picker.addEventListener("blur", () => { picker.classList.remove("due-input"); renderTasks(); });
  dueWrap.append(dueText, picker);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.setAttribute("aria-label", "Delete: " + task.title);
  del.textContent = "×";
  del.addEventListener("click", () => deleteTask(task));

  li.append(check, text);
  if (full && state.lists.length > 1) {
    // Which list the task lives in; ideas also say how long they take
    const move = document.createElement("select");
    move.className = "task-pick list-pick";
    move.setAttribute("aria-label", "List: " + task.title);
    state.lists.forEach((l) => { const o = document.createElement("option"); o.value = l.id; o.textContent = l.name; move.appendChild(o); });
    move.value = listOf(task);
    move.addEventListener("change", () => setTaskList(task, move.value));
    li.appendChild(move);
    if (listOf(task) === IDEAS) {
      const mins = document.createElement("select");
      mins.className = "task-pick has-course";
      mins.setAttribute("aria-label", "Time needed: " + task.title);
      [[0, "Any time"], [15, "15 min"], [30, "30 min"], [60, "1 hour"], [120, "2 hours"]].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; mins.appendChild(o); });
      mins.value = task.mins || 0;
      mins.addEventListener("change", () => setTaskMins(task, Number(mins.value)));
      li.appendChild(mins);
    }
  }
  if (full) {
    const sel = document.createElement("select");
    sel.className = "course-pick" + (task.course ? " has-course" : "");
    if (task.course) sel.style.setProperty("--c", courseColour(task.course));
    sel.setAttribute("aria-label", "Subject: " + task.title);
    const names = task.course && !state.courses.includes(task.course) ? [task.course, ...state.courses] : state.courses;
    [["", task.course ? "No subject" : "Subject"], ...names.map((c) => [c, c]), ["__edit", "Edit subjects…"]].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = task.course || "";
    sel.addEventListener("change", () => {
      if (sel.value === "__edit") { sel.value = task.course || ""; location.hash = "#settings"; return; }
      setTaskCourse(task, sel.value);
    });
    const flag = document.createElement("button");
    flag.type = "button";
    flag.className = "pri";
    flag.textContent = pri === "low" ? "↓" : "!";
    const next = PRIORITIES[(PRIORITIES.indexOf(pri) + 1) % PRIORITIES.length];
    flag.setAttribute("aria-label", "Priority " + pri + ". Change to " + next + ": " + task.title);
    flag.title = "Priority: " + pri;
    flag.addEventListener("click", () => setTaskPriority(task, next));
    li.append(sel, flag);
  } else if (task.course) {
    const tag = document.createElement("span");
    tag.className = "task-course";
    tag.textContent = task.course;
    li.appendChild(tag);
  }
  li.append(dueWrap, del);
  return li;
}

// Swap the task name for a text box. Return or tapping away saves; Escape cancels.
function editTask(task, titleEl) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "task-edit";
  input.maxLength = MAX_TITLE;
  input.value = task.title;
  input.setAttribute("aria-label", "Task name");
  input.enterKeyHint = "done";
  let cancelled = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { cancelled = true; input.blur(); }
  });
  input.addEventListener("blur", () => {
    if (!cancelled) renameTask(task, input.value);
    input.classList.remove("task-edit");   // typing is over, so drawing is allowed again
    renderTasks();   // redraw now that typing is over (also picks up changes that arrived meanwhile)
  });
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}
const isEditingTask = () => {
  const el = document.activeElement;
  return !!(el && (el.classList.contains("task-edit") || el.classList.contains("due-input")));
};

function addForm(placeholder, list) {
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
    if (addTask(input.value, list)) input.value = "";
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
  let host = $("todo-full");
  if (state.status === "loading") return skeleton(host);
  if (state.status === "error") return errorBox(host, "Couldn't load your tasks.");
  host.textContent = "";
  const main = document.createElement("div"), side = document.createElement("aside");
  main.className = "todo-main"; side.className = "todo-side";
  host.append(main, side);
  const hostAll = host;
  host = main;
  const view = state.lists.some((l) => l.id === pref("todo-list", "")) ? pref("todo-list", "") : "";
  const all = state.tasks.filter((t) => !t.done && (view ? listOf(t) === view : true)).sort(byPriority);
  const done = doneTasks();
  // Lists are the main switch
  const seg = $("todo-lists");
  seg.textContent = "";
  [["", "All"], ...state.lists.map((l) => [l.id, l.name])].forEach(([id, name]) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = name;
    b.setAttribute("aria-pressed", String(id === view));
    b.addEventListener("click", () => { setPref("todo-list", id); renderTodoPage(); });
    seg.appendChild(b);
  });
  const more = document.createElement("a");
  more.href = "#settings"; more.textContent = "+ New list";
  more.addEventListener("click", () => setTimeout(() => $("list-new").focus(), 60));
  seg.appendChild(more);
  // Filter by subject, offered once any open task has one
  const used = [...new Set(all.map((t) => t.course).filter(Boolean))].sort();
  const filter = used.includes(todoFilter()) ? todoFilter() : "";
  const open = filter ? all.filter((t) => t.course === filter) : all;
  if (used.length) {
    const pick = document.createElement("select");
    pick.className = "todo-filter";
    pick.setAttribute("aria-label", "Show tasks for");
    [["", "All subjects"], ...used.map((c) => [c, c])].forEach(([value, label]) => {
      const o = document.createElement("option");
      o.value = value; o.textContent = label;
      pick.appendChild(o);
    });
    pick.value = filter;
    pick.addEventListener("change", () => { try { localStorage.setItem("hb-todo-course", pick.value); } catch (e) {} renderTodoPage(); });
    host.appendChild(pick);
  }

  if (open.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = view === IDEAS ? "Nothing here yet. Add things you'd enjoy doing when you have a free hour."
      : done.length ? "All done. Nice work." : "No tasks yet. Type one below and press Return.";
    host.appendChild(p);
  } else {
    // "All" shows each list that has something in it, under its name
    (view ? [state.lists.find((l) => l.id === view)] : state.lists).forEach((l) => {
      const items = open.filter((t) => listOf(t) === l.id);
      if (!items.length) return;
      if (!view) {
        const h = document.createElement("h3");
        h.className = "todo-section";
        h.textContent = l.name + " · " + items.length;
        host.appendChild(h);
      }
      const ul = document.createElement("ul");
      ul.className = "tasks";
      items.forEach((t) => ul.appendChild(taskItem(t, true)));
      host.appendChild(ul);
    });
  }
  const target = view || lastList();
  host.appendChild(addForm("Add a task to " + state.lists.find((l) => l.id === target).name, target));
  host = side;

  // Quizzes and assignments from your calendar (Canvas). Ticking one here clears it there too.
  const upcoming = upcomingDeadlines();
  if (upcoming.length) {
    const h = document.createElement("h3");
    h.className = "todo-section";
    h.textContent = "Deadlines · next 2 weeks";
    const ul = document.createElement("ul");
    ul.className = "tasks";
    upcoming.forEach((ev) => ul.appendChild(upcomingItem(ev)));
    host.append(h, ul);
  }

  if (done.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "completed-toggle";
    toggle.setAttribute("aria-expanded", String(state.showCompleted));
    toggle.classList.add("done-block");
    const big = document.createElement("b"), words = document.createElement("span"), small = document.createElement("small");
    big.textContent = doneToday();
    small.textContent = "Done today";
    words.append(small, (state.showCompleted ? "Hide finished tasks" : "Show finished tasks") + " · " + done.length);
    toggle.append(big, words);
    toggle.addEventListener("click", () => { state.showCompleted = !state.showCompleted; renderTodoPage(); });
    host.appendChild(toggle);
    if (state.showCompleted) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      done.forEach((t) => ul.appendChild(taskItem(t)));
      host.appendChild(ul);
    }
  }

  // Calendar deadlines you marked done (last 30 days). Untick one to put it back on the calendar.
  const deadlines = recentDoneDeadlines();
  if (deadlines.length) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "completed-toggle";
    toggle.setAttribute("aria-expanded", String(state.showDoneDeadlines));
    toggle.textContent = (state.showDoneDeadlines ? "▾ " : "▸ ") + "Done deadlines " + deadlines.length;
    toggle.addEventListener("click", () => { state.showDoneDeadlines = !state.showDoneDeadlines; renderTodoPage(); });
    host.appendChild(toggle);
    if (state.showDoneDeadlines) {
      const ul = document.createElement("ul");
      ul.className = "tasks";
      deadlines.forEach((d) => ul.appendChild(deadlineItem(d)));
      host.appendChild(ul);
    }
  }
}

const DEADLINE_DAYS_AHEAD = 14;
function upcomingDeadlines() {
  if (!state.events.length) return [];
  const from = startOfDay(new Date()).getTime(), to = addDays(startOfDay(new Date()), DEADLINE_DAYS_AHEAD + 1).getTime();
  const list = state.events.filter((e) => e.cat === "due" && e.startMs >= from && e.startMs < to && !state.doneEvents.has(e.id));
  return dedupe(list).sort((a, b) => a.startMs - b.startMs);
}
function upcomingItem(ev) {
  const li = document.createElement("li");
  li.className = "task";
  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", "Mark done: " + ev.title);
  check.setAttribute("aria-pressed", "false");
  check.addEventListener("click", () => {
    li.classList.add("check-anim");
    playTick();
    setTimeout(() => markEventDone(ev), 260);
  });
  const text = document.createElement("span");
  text.className = "task-title";
  text.tabIndex = 0;
  text.setAttribute("role", "button");
  text.setAttribute("aria-label", "Details: " + ev.title);
  text.textContent = ev.title;
  text.addEventListener("click", () => openEventSheet(ev));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openEventSheet(ev); } });
  const due = document.createElement("span");
  due.className = "due has-due";
  due.textContent = dueLabel(ymd(new Date(ev.startMs))) + (ev.allDay ? "" : " · " + fmtTime(ev.startMs));
  li.append(check, text, due);
  return li;
}

const DONE_DEADLINE_DAYS = 30;
function recentDoneDeadlines() {
  const since = Date.now() - DONE_DEADLINE_DAYS * 86400000;
  return state.doneList.filter((d) => (d.updatedAt || 0) >= since && !d.eventId.startsWith("hifz:")).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function deadlineItem(d) {
  const li = document.createElement("li");
  li.className = "task is-done";
  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", "Put back on the calendar: " + d.title);
  check.setAttribute("aria-pressed", "true");
  check.addEventListener("click", () => {
    setEventDone({ id: d.eventId, title: d.title }, false);
    toast("Back on your calendar", "Undo", () => setEventDone({ id: d.eventId, title: d.title }, true));
  });
  const text = document.createElement("span");
  text.className = "task-title";
  text.textContent = d.title;
  li.append(check, text);
  return li;
}

function renderTasks() {
  if (isEditingTask()) return;   // don't wipe the text box mid-typing; it redraws when typing ends
  renderTodayCard();
  renderTodoPage();
  renderSummary();
  if (!drawingCalendar) renderCalendar();   // tasks with a due date show on the calendar
}

export { isEditingTask, renderTasks, renderTodayCard, renderTodoPage, skeleton };
