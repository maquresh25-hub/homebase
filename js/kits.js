import { daysLeft, nextExam } from "./calendar.js";
import { cleanCourse, courseColour } from "./courses.js";
import { fb } from "./firebase.js";
import { state } from "./state.js";
import { save } from "./tasks.js";
import { toast } from "./toast.js";
import { skeleton } from "./todo.js";
import { $, fmtTime } from "./util.js";

function renderExamCard() {
  const host = $("exam-card");
  if (examKitEditing && host.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
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

  // Exam kit: one tap opens it. The link is saved per exam name and syncs.
  const key = kitKey(exam);
  const link = state.kitLinks[key];
  const row = document.createElement("div");
  row.className = "kit-row";
  if (link && !examKitEditing) {
    const open = document.createElement("a");
    open.className = "btn-primary kit-open";
    open.href = link; open.target = "_blank"; open.rel = "noopener";
    open.textContent = "Open exam kit";
    const change = document.createElement("button");
    change.type = "button"; change.className = "btn-link"; change.textContent = "Change link";
    change.addEventListener("click", () => { examKitEditing = true; renderExamCard(); });
    row.append(open, change);
  } else if (examKitEditing) {
    const form = document.createElement("form");
    form.className = "kit-form";
    form.noValidate = true;   // our own message below, not the browser's bubble
    const input = document.createElement("input");
    input.type = "url"; input.inputMode = "url"; input.placeholder = "Paste the exam kit link";
    input.value = link || ""; input.autocapitalize = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", "Exam kit link for " + exam.title);
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit"; saveBtn.className = "btn-primary"; saveBtn.textContent = "Save";
    const err = document.createElement("p");
    err.className = "form-error"; err.setAttribute("role", "alert");
    form.append(input, saveBtn);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (url && !/^https:\/\/[^\s]+$/i.test(url)) { err.textContent = "That doesn't look like a link. It should start with https://"; return; }
      examKitEditing = false;
      saveKitLink(key, url);
    });
    const cancel = document.createElement("button");
    cancel.type = "button"; cancel.className = "btn-link"; cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => { examKitEditing = false; renderExamCard(); });
    row.append(form, err, cancel);
    setTimeout(() => input.focus(), 0);
  } else {
    const add = document.createElement("button");
    add.type = "button"; add.className = "btn-link"; add.textContent = "Add exam kit link";
    add.addEventListener("click", () => { examKitEditing = true; renderExamCard(); });
    row.appendChild(add);
  }
  host.appendChild(row);
}
let examKitEditing = false;
const kitKey = (exam) => exam.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80) || "exam";
function kitsRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "kits"); }
function saveKitLink(key, url) {
  if (!state.kitsLoaded) { toast("Your kits haven't loaded yet. Check your connection and try again."); return; }
  const links = { ...state.kitLinks };
  if (url) links[key] = url; else delete links[key];
  state.kitLinks = links;
  renderExamCard();
  save(fb.setDoc(kitsRef(), { links, items: state.kits, updatedAt: Date.now() }));
}
// Exam kits listed in the Study tab: { id, title, url, course }
const cleanKit = (k) => {
  const title = cleanCourse(k && k.title).slice(0, 80), url = String((k && k.url) || "").trim().slice(0, 500);
  return title && /^https:\/\/\S+$/i.test(url) ? { id: String((k && k.id) || "k" + Math.random().toString(36).slice(2, 9)), title, url, course: cleanCourse(k && k.course) } : null;
};
function saveKits(items) {
  if (!state.kitsLoaded) { toast("Your kits haven't loaded yet. Check your connection and try again."); return; }
  state.kits = items.slice(0, 60);
  renderKits();
  save(fb.setDoc(kitsRef(), { links: state.kitLinks, items: state.kits, updatedAt: Date.now() }));
}
function pendingKits() { try { return (JSON.parse(sessionStorage.getItem("hb-kit-import") || "[]") || []).map(cleanKit).filter(Boolean); } catch (e) { return []; } }
function renderKits() {
  const host = $("kit-list"), pick = $("kit-course");
  if (!host) return;
  host.textContent = "";
  const keep = pick.value;
  pick.textContent = "";
  [["", "No subject"], ...state.courses.map((c) => [c, c])].forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; pick.appendChild(o); });
  pick.value = state.courses.includes(keep) ? keep : "";
  const waiting = pendingKits().filter((k) => !state.kits.some((x) => x.url === k.url));
  if (waiting.length && state.user && state.kitsLoaded) {
    const box = document.createElement("div");
    box.className = "kit-import";
    const text = document.createElement("span");
    text.textContent = waiting.length + (waiting.length === 1 ? " exam kit is" : " exam kits are") + " ready to add.";
    const add = document.createElement("button");
    add.type = "button"; add.className = "btn-primary"; add.textContent = "Add all";
    add.addEventListener("click", () => { try { sessionStorage.removeItem("hb-kit-import"); } catch (e) {} saveKits([...state.kits, ...waiting]); });
    box.append(text, add);
    host.appendChild(box);
  }
  if (!state.kits.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No kits yet. Add the link to any exam kit and it opens from here in one tap.";
    host.appendChild(p);
    return;
  }
  const groups = [...new Set(state.kits.map((k) => k.course || ""))].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  groups.forEach((g) => {
    const h = document.createElement("h3");
    h.className = "list-head";
    h.textContent = g || "Other";
    const ul = document.createElement("ul");
    ul.className = "kit-rows";
    state.kits.filter((k) => (k.course || "") === g).forEach((k) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = k.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = k.title;
      if (g) a.style.setProperty("--c", courseColour(g));
      const del = document.createElement("button");
      del.type = "button"; del.className = "del"; del.textContent = "×";
      del.setAttribute("aria-label", "Remove kit: " + k.title);
      del.addEventListener("click", () => { const before = state.kits; saveKits(before.filter((x) => x.id !== k.id)); toast("Kit removed", "Undo", () => saveKits(before)); });
      li.append(a, del);
      ul.appendChild(li);
    });
    host.append(h, ul);
  });
}
async function loadKitLinks() {
  state.kitLinks = {}; state.kits = []; state.kitsLoaded = false;
  try {
    const snap = await fb.getDoc(kitsRef());
    const links = snap.exists() ? snap.data().links : null;
    const items = snap.exists() ? snap.data().items : null;
    state.kits = Array.isArray(items) ? items.map(cleanKit).filter(Boolean).slice(0, 60) : [];
    state.kitsLoaded = true;   // only now is it safe to save kits: a failed read must never overwrite them
    if (links && typeof links === "object") {
      state.kitLinks = Object.fromEntries(Object.entries(links).filter(([, v]) => typeof v === "string" && /^https:\/\//i.test(v)));
    }
  } catch (e) { console.warn("Couldn't read exam kit links:", e); }
  renderExamCard();
  renderKits();
}


export { cleanKit, loadKitLinks, renderExamCard, renderKits, saveKits };
