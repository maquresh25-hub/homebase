// ---- Subjects: one list (users/{uid}/settings/courses) that tasks and the missed-questions form pick from
import * as theme from "../theme.js";
import { fb } from "./firebase.js";
import { applyLook } from "./look.js";
import { state } from "./state.js";
import { save } from "./tasks.js";
import { toast } from "./toast.js";
import { isEditingTask, renderTodoPage } from "./todo.js";
import { $ } from "./util.js";

const MAX_COURSES = 30;
function cleanCourse(raw) { return String(raw || "").replace(/\s+/g, " ").trim().slice(0, 40); }
function coursesRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "courses"); }
function saveCourses(list) {
  state.courses = list;
  renderCourses();
  if (!isEditingTask()) renderTodoPage();
  // keep only the colours of subjects still on the list
  const colors = Object.fromEntries(list.filter((c) => state.courseColors[c]).map((c) => [c, state.courseColors[c]]));
  save(fb.setDoc(coursesRef(), { list, colors, updatedAt: Date.now() }));
}
function courseColour(name) { return state.courseColors[name] || theme.defaultColour(name, state.courses.indexOf(name)); }
function setCourseColour(name, colour) {
  if (!theme.isColour(colour)) return;
  state.courseColors = { ...state.courseColors, [name]: colour.toUpperCase() };
  saveCourses(state.courses);
}
async function loadCourses() {
  state.courses = [];
  try {
    const snap = await fb.getDoc(coursesRef());
    const list = snap.exists() ? snap.data().list : null;
    if (Array.isArray(list)) state.courses = [...new Set(list.map(cleanCourse).filter(Boolean))].slice(0, MAX_COURSES);
    const colors = snap.exists() ? snap.data().colors : null;
    state.courseColors = {};
    if (colors && typeof colors === "object") state.courses.forEach((c) => { if (theme.isColour(colors[c])) state.courseColors[c] = colors[c].toUpperCase(); });
  } catch (e) { console.warn("Couldn't read your subjects:", e); }
  renderCourses();
  if (!isEditingTask()) renderTodoPage();
}
// One name, or several separated by commas or new lines ("BIO 2000, Chem 1130")
function addCourse(raw) {
  const names = String(raw || "").split(/[,;\n]+/).map(cleanCourse).filter(Boolean);
  if (names.length > 1) {
    const have = new Set(state.courses.map((c) => c.toLowerCase())), fresh = [];
    names.forEach((n) => { if (!have.has(n.toLowerCase()) && state.courses.length + fresh.length < MAX_COURSES) { have.add(n.toLowerCase()); fresh.push(n); } });
    if (!fresh.length) { toast("Those subjects are already on the list."); return false; }
    saveCourses([...state.courses, ...fresh]);
    toast("Added " + fresh.length + " subjects");
    return true;
  }
  const name = names[0];
  if (!name) return false;
  if (state.courses.some((c) => c.toLowerCase() === name.toLowerCase())) { toast("That subject is already on the list."); return false; }
  if (state.courses.length >= MAX_COURSES) { toast("That's the limit of " + MAX_COURSES + " subjects."); return false; }
  saveCourses([...state.courses, name]);
  return true;
}
function renderCourses() {
  const host = $("course-list"), options = $("course-options");
  if (!host) return;
  applyLook();
  host.textContent = ""; options.textContent = "";
  if (!state.courses.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No subjects yet.";
    host.appendChild(li);
  }
  state.courses.forEach((c) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = c;
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "course-colour";
    swatch.value = courseColour(c).toLowerCase();
    swatch.setAttribute("aria-label", "Colour for " + c);
    swatch.addEventListener("change", () => setCourseColour(c, swatch.value));
    const del = document.createElement("button");
    del.type = "button"; del.className = "del"; del.textContent = "×";
    del.setAttribute("aria-label", "Remove subject: " + c);
    del.addEventListener("click", () => {
      const before = state.courses;
      saveCourses(before.filter((x) => x !== c));
      toast("Subject removed", "Undo", () => saveCourses(before));
    });
    li.append(swatch, name, del);
    host.appendChild(li);
    const o = document.createElement("option");
    o.value = c;
    options.appendChild(o);
  });
}

export { MAX_COURSES, addCourse, cleanCourse, courseColour, loadCourses, renderCourses };
