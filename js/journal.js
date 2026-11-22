// ================================================================ JOURNAL
// One private entry a day. The text is encrypted on this device with your passphrase before it is saved (vault.js),
// so it is unreadable online. Stored in users/{uid}/journal/{yyyy-mm-dd}; the passphrase check lives in settings/journal.
import * as vault from "../vault.js";
import { fb } from "./firebase.js";
import { state } from "./state.js";
import { $, fmtTime, pref, setPref, ymd } from "./util.js";

const PROMPTS = [
  ["well", "What went well today, and why?"],
  ["differently", "What would I do differently?"],
  ["grateful", "One thing I'm grateful for"],
  ["tomorrow", "Tomorrow's one priority"],
  ["more", "Anything else on my mind"],
];
const journal = { setup: undefined, key: null, docs: new Map(), day: "", shown: "", unsub: null, busy: false };
const journalKeyName = () => "jk:" + (state.user ? state.user.uid : "");
function journalRef(day) { return fb.doc(fb.db, "users", state.user.uid, "journal", day); }
function journalSetupRef() { return fb.doc(fb.db, "users", state.user.uid, "settings", "journal"); }
async function startJournal(user) {
  journal.setup = undefined; journal.docs = new Map(); journal.shown = ""; journal.ready = false;
  journal.key = pref(journalKeyName(), "") || null;
  try {
    const snap = await fb.getDoc(journalSetupRef());
    const d = snap.exists() ? snap.data() : null;
    journal.setup = d && d.salt && d.check ? { salt: d.salt, check: d.check } : null;
  } catch (e) { console.warn("Couldn't read the journal setup:", e); journal.setup = "error"; }   // never offer "set a passphrase" on a failed read: that would orphan every entry
  journal.unsub = fb.onSnapshot(fb.collection(fb.db, "users", user.uid, "journal"), (snap) => {
    journal.docs = new Map(snap.docs.map((d) => [d.id, d.data()]));
    const first = !journal.ready;
    journal.ready = true;
    if ($("view-journal").hidden) return;
    if (first) renderJournal(); else renderJournalSide();
  }, (e) => console.warn("Couldn't load journal entries:", e));
  if (!$("view-journal").hidden) renderJournal();
}
function stopJournal() {
  if (journal.unsub) journal.unsub();
  Object.assign(journal, { setup: undefined, key: null, docs: new Map(), shown: "", unsub: null, ready: false });
}
function journalDate(day) { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); }
function passForm(first) {
  const form = document.createElement("form");
  form.className = "journal-lock";
  form.noValidate = true;
  const h = document.createElement("h2"), p = document.createElement("p"), err = document.createElement("p");
  h.textContent = first ? "Set a journal passphrase" : "Unlock your journal";
  p.className = "empty";
  p.textContent = first
    ? "Your entries are locked with this passphrase before they are saved, so nobody else can read them. If you forget it, the entries cannot be recovered, so write it down somewhere safe. You'll enter it once on each device."
    : "Enter your journal passphrase. You only do this once on this device.";
  err.className = "form-error"; err.setAttribute("role", "alert");
  const mkInput = (label) => { const i = document.createElement("input"); i.type = "password"; i.autocomplete = first ? "new-password" : "current-password"; i.placeholder = label; i.setAttribute("aria-label", label); i.maxLength = 200; return i; };
  const a = mkInput("Passphrase"), b = first ? mkInput("Type it again") : null;
  const go = document.createElement("button");
  go.type = "submit"; go.className = "btn-primary"; go.textContent = first ? "Set passphrase" : "Unlock";
  form.append(h, p, a, ...(b ? [b] : []), err, go);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (journal.busy) return;
    err.textContent = "";
    if (first && a.value.length < 8) { err.textContent = "Use at least 8 characters."; return; }
    if (first && a.value !== b.value) { err.textContent = "The two don't match."; return; }
    if (!a.value) return;
    journal.busy = true; go.disabled = true;
    try {
      if (first) {
        const salt = vault.newSalt(), key = await vault.keyFromPassphrase(a.value, salt);
        const check = await vault.seal(key, "homebase");
        await fb.setDoc(journalSetupRef(), { salt, check, createdAt: Date.now() });
        journal.setup = { salt, check }; journal.key = key;
      } else {
        const key = await vault.keyFromPassphrase(a.value, journal.setup.salt);
        try { await vault.open(key, journal.setup.check); } catch (bad) { err.textContent = "That passphrase doesn't match."; return; }
        journal.key = key;
      }
      setPref(journalKeyName(), journal.key);
      journal.shown = "";
      renderJournal();
    } catch (x) { console.error(x); err.textContent = "Something went wrong. Check your connection and try again."; }
    finally { journal.busy = false; go.disabled = false; }
  });
  return form;
}
function renderJournalSide() {
  const side = $("journal-side");
  side.textContent = "";
  if (!journal.key) return;
  const h = document.createElement("h2");
  h.textContent = "Entries";
  side.appendChild(h);
  const today = ymd(new Date());
  const days = [...new Set([today, ...journal.docs.keys()])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, 60);
  const ul = document.createElement("ul");
  ul.className = "journal-days";
  days.forEach((d) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button";
    b.textContent = d === today ? "Today" : journalDate(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    b.setAttribute("aria-current", String(d === journal.day));
    if (!journal.docs.has(d)) b.classList.add("is-empty");
    b.addEventListener("click", () => { journal.day = d; journal.shown = ""; renderJournal(); });
    li.appendChild(b); ul.appendChild(li);
  });
  side.appendChild(ul);
  const lock = document.createElement("button");
  lock.type = "button"; lock.className = "btn-link"; lock.textContent = "Lock on this device";
  lock.addEventListener("click", () => { journal.key = null; try { localStorage.removeItem("hb-" + journalKeyName()); } catch (e) {} journal.shown = ""; renderJournal(); });
  side.appendChild(lock);
}
async function renderJournal() {
  const main = $("journal-main");
  if (!journal.day) journal.day = ymd(new Date());
  $("journal-day").textContent = journalDate(journal.day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (!state.user || journal.setup === undefined || !journal.ready) { main.innerHTML = '<p class="empty">Loading…</p>'; $("journal-side").textContent = ""; return; }
  if (journal.setup === "error") { main.innerHTML = '<p class="empty">Couldn\'t load your journal. Check your connection and reload.</p>'; $("journal-side").textContent = ""; return; }
  if (!journal.setup || !journal.key) { main.textContent = ""; main.appendChild(passForm(!journal.setup)); $("journal-side").textContent = ""; return; }
  renderJournalSide();
  if (journal.shown === journal.day) return;        // never redraw the page under what you're typing
  const day = journal.day;
  let entry = {};
  const box = journal.docs.get(day);
  if (box && box.data) {
    try { entry = (await vault.open(journal.key, box)) || {}; }
    catch (e) { main.innerHTML = '<p class="empty">This entry can\'t be opened with the passphrase on this device. Lock and unlock again with the right one.</p>'; return; }
  }
  if (day !== journal.day) return;
  journal.shown = day;
  main.textContent = "";
  const form = document.createElement("form");
  form.className = "journal-entry";
  const fields = {};
  PROMPTS.forEach(([id, label]) => {
    const wrap = document.createElement("label"), t = document.createElement("textarea"), s = document.createElement("span");
    s.textContent = label;
    t.rows = id === "more" ? 5 : 2; t.maxLength = 4000; t.value = (entry.answers && entry.answers[id]) || "";
    wrap.append(s, t); form.appendChild(wrap); fields[id] = t;
  });
  const bar = document.createElement("div"), saveBtn = document.createElement("button"), note = document.createElement("span");
  bar.className = "journal-bar";
  saveBtn.type = "submit"; saveBtn.className = "btn-primary"; saveBtn.textContent = "Save";
  note.className = "journal-note"; note.setAttribute("role", "status");
  note.textContent = box && box.updatedAt ? "Saved " + fmtTime(box.updatedAt) + " · locked with your passphrase" : "Not saved yet";
  bar.append(saveBtn, note); form.appendChild(bar);
  const saveEntry = async () => {
    const answers = Object.fromEntries(PROMPTS.map(([id]) => [id, fields[id].value.trim()]));
    try {
      const sealed = await vault.seal(journal.key, { v: 1, answers });
      const now = Date.now();
      journal.docs.set(day, { ...sealed, updatedAt: now });
      await fb.setDoc(journalRef(day), { ...sealed, updatedAt: now });
      note.textContent = "Saved " + fmtTime(now) + " · locked with your passphrase";
      renderJournalSide();
    } catch (e) { console.error(e); note.textContent = "Couldn't save. Check your connection."; }
  };
  form.addEventListener("submit", (e) => { e.preventDefault(); saveEntry(); });
  form.addEventListener("change", saveEntry);     // leaving a box saves it
  main.appendChild(form);
}


export { renderJournal, startJournal, stopJournal };
