import { daysLeft, nextExam } from "./calendar.js";
import { cleanCourse } from "./courses.js";
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
    const video = videoEmbed(link);
    const open = document.createElement(video ? "button" : "a");
    open.className = "btn-primary kit-open";
    open.textContent = video ? "Play video" : "Open exam kit";
    if (video) {
      open.type = "button";
      open.addEventListener("click", () => openPlayer(exam.title, link, open));
    } else {
      open.href = link; open.target = "_blank"; open.rel = "noopener";
    }
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
// YouTube (privacy-enhanced) or Vimeo. Anything else cannot be embedded.
function videoEmbed(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  let youtubeId = "";
  if (host === "youtu.be") youtubeId = u.pathname.split("/").filter(Boolean)[0] || "";
  else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") youtubeId = u.searchParams.get("v") || "";
    else {
      const parts = u.pathname.split("/").filter(Boolean);
      const slot = parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" ? parts[1] : "";
      youtubeId = slot || "";
    }
  }
  if (/^[\w-]{6,}$/.test(youtubeId)) {
    return {
      kind: "youtube", id: youtubeId,
      embed: "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(youtubeId) + "?rel=0",
      external: "https://www.youtube.com/watch?v=" + encodeURIComponent(youtubeId),
      externalLabel: "Open on YouTube",
    };
  }
  let vimeoId = "";
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    vimeoId = u.pathname.split("/").filter(Boolean).reverse().find((p) => /^\d{6,}$/.test(p)) || "";
  }
  if (vimeoId) {
    return {
      kind: "vimeo", id: vimeoId,
      embed: "https://player.vimeo.com/video/" + vimeoId,
      external: "https://vimeo.com/" + vimeoId,
      externalLabel: "Open on Vimeo",
    };
  }
  return null;
}
function cleanVideo(v) {
  if (typeof v === "string") v = { url: v };
  const url = String((v && v.url) || "").trim().slice(0, 500);
  if (!videoEmbed(url)) return null;
  const title = cleanCourse(v && v.title).slice(0, 80) || "Video";
  return { id: String((v && v.id) || "v" + Math.random().toString(36).slice(2, 9)), title, url };
}
// Exam kits listed in the Study tab: { id, title, url, course, videos }
const cleanKit = (k) => {
  const title = cleanCourse(k && k.title).slice(0, 80), url = String((k && k.url) || "").trim().slice(0, 500);
  const videos = Array.isArray(k && k.videos) ? k.videos.map(cleanVideo).filter(Boolean).slice(0, 12) : [];
  return title && /^https:\/\/\S+$/i.test(url) ? { id: String((k && k.id) || "k" + Math.random().toString(36).slice(2, 9)), title, url, course: cleanCourse(k && k.course), videos } : null;
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
    state.kits.filter((k) => (k.course || "") === g).forEach((k) => ul.appendChild(kitRow(k, g)));
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


function kitRow(k, course) {
  const li = document.createElement("li");
  const main = document.createElement("div");
  main.className = "kit-main";
  if (course) {
    const label = document.createElement("p");
    label.className = "kit-course";
    label.textContent = course;
    main.appendChild(label);
  }
  const own = videoEmbed(k.url);
  const title = document.createElement(own ? "button" : "a");
  title.className = "kit-title-link";
  title.textContent = k.title;
  if (own) {
    title.type = "button";
    title.addEventListener("click", () => openPlayer(k.title, k.url, title));
  } else {
    title.href = k.url; title.target = "_blank"; title.rel = "noopener";
  }
  main.appendChild(title);
  main.appendChild(videoSection(k));
  const del = document.createElement("button");
  del.type = "button"; del.className = "nav-btn kit-remove"; del.textContent = "Remove";
  del.setAttribute("aria-label", "Remove kit: " + k.title);
  del.addEventListener("click", () => { const before = state.kits; saveKits(before.filter((x) => x.id !== k.id)); toast("Kit removed", "Undo", () => saveKits(before)); });
  li.append(main, del);
  return li;
}
function videoSection(k) {
  const box = document.createElement("div");
  box.className = "kit-videos";
  const label = document.createElement("p");
  label.className = "kit-course";
  label.textContent = "Videos";
  box.appendChild(label);
  const videos = k.videos || [];
  if (!videos.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No videos yet.";
    box.appendChild(empty);
  } else {
    const ul = document.createElement("ul");
    ul.className = "kit-video-list";
    videos.forEach((v) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "kit-video-btn"; btn.textContent = v.title;
      btn.addEventListener("click", () => openPlayer(v.title, v.url, btn));
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn-link"; del.textContent = "Remove video";
      del.addEventListener("click", () => {
        const before = state.kits;
        saveKits(before.map((x) => x.id === k.id ? { ...x, videos: (x.videos || []).filter((y) => y.id !== v.id) } : x));
        toast("Video removed", "Undo", () => saveKits(before));
      });
      li.append(btn, del);
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  const form = document.createElement("form");
  form.className = "kit-video-add";
  form.noValidate = true;
  const titleLabel = document.createElement("label");
  titleLabel.className = "kit-label";
  titleLabel.textContent = "Video title";
  const title = document.createElement("input");
  title.type = "text"; title.maxLength = 80; title.autocomplete = "off"; title.placeholder = "e.g. Chapter 4 review";
  titleLabel.htmlFor = title.id = "vid-title-" + k.id;
  const urlLabel = document.createElement("label");
  urlLabel.className = "kit-label";
  urlLabel.textContent = "YouTube or Vimeo link";
  const url = document.createElement("input");
  url.type = "url"; url.maxLength = 500; url.placeholder = "https://";
  url.autocapitalize = "off"; url.spellcheck = false;
  urlLabel.htmlFor = url.id = "vid-url-" + k.id;
  const err = document.createElement("p");
  err.className = "form-error"; err.setAttribute("role", "alert");
  const add = document.createElement("button");
  add.type = "submit"; add.className = "btn-primary"; add.textContent = "Add video";
  form.append(titleLabel, title, urlLabel, url, err, add);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    err.textContent = "";
    const video = cleanVideo({ title: title.value, url: url.value });
    if (!video) { err.textContent = "Use a YouTube or Vimeo link, and give it a title. Other links can't play inside Homebase."; return; }
    if (!state.user || !state.kitsLoaded) { toast("Sign in to save videos with your kits."); return; }
    saveKits(state.kits.map((x) => x.id === k.id ? { ...x, videos: [...(x.videos || []), video].slice(0, 12) } : x));
  });
  box.appendChild(form);
  return box;
}
let playerOpener = null;
let playerWired = false;
function wirePlayer() {
  if (playerWired || !$("video-sheet")) return;
  playerWired = true;
  const sheet = $("video-sheet");
  $("video-close").addEventListener("click", closePlayer);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closePlayer(); });
  document.addEventListener("keydown", (e) => {
    if (sheet.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closePlayer(); return; }
    if (e.key !== "Tab") return;
    const nodes = [...sheet.querySelectorAll("button, a[href]")].filter((el) => !el.hidden);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
function openPlayer(title, url, opener) {
  wirePlayer();
  const sheet = $("video-sheet"), frame = $("video-frame"), err = $("video-error"), ext = $("video-external");
  if (!sheet) return;
  playerOpener = opener || null;
  $("video-title").textContent = title || "Video";
  frame.textContent = "";
  frame.hidden = true;
  err.hidden = true;
  err.textContent = "";
  const parsed = videoEmbed(url);
  if (parsed) {
    const iframe = document.createElement("iframe");
    iframe.src = parsed.embed;
    iframe.title = title || "Video";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    frame.appendChild(iframe);
    frame.hidden = false;
    ext.hidden = false;
    ext.href = parsed.external;
    ext.textContent = parsed.externalLabel;
  } else {
    err.hidden = false;
    err.textContent = "That link can't play inside Homebase. Use a YouTube or Vimeo link.";
    const raw = String(url || "").trim();
    if (/^https:\/\/\S+$/i.test(raw)) { ext.hidden = false; ext.href = raw; ext.textContent = "Open the link"; }
    else { ext.hidden = true; ext.removeAttribute("href"); ext.textContent = ""; }
  }
  sheet.hidden = false;
  $("video-close").focus();
}
function closePlayer() {
  const sheet = $("video-sheet"), frame = $("video-frame");
  if (sheet) sheet.hidden = true;
  if (frame) { frame.textContent = ""; frame.hidden = true; }
  if (playerOpener && playerOpener.focus) playerOpener.focus();
  playerOpener = null;
}
export { cleanKit, loadKitLinks, openPlayer, renderExamCard, renderKits, saveKits, videoEmbed };
