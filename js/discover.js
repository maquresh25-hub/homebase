// ================================================================ DISCOVER
// Ideas for free time near home: real places, a free slot that respects his protected blocks,
// and a drafted invite for his sister (never sent by the app). Ideas come from
// users/{uid}/discover/{id}, written by his assistant; this tab only reads them.
// Signed out, or with none yet, it shows a few sample ideas so the tab is still useful.
//   { title, category: "restorative"|"newHobby"|"social"|"outdoors"|"food", place, address, lat, lon, hours,
//     suggestedStart, suggestedEnd (ISO with ET offset), mapsUrl, url, sisterFriendly: bool, halalNote, notes, cost, createdAt }
import { km } from "../theme.js";
import { fb } from "./firebase.js";
import { downloadIcs } from "./ics.js";
import { locate, place } from "./location.js";
import { HOME_POINT, freeSlots, isSunday, overlapsProtected } from "./protected.js";
import { state } from "./state.js";
import { IDEAS, addTask, openIdeas } from "./tasks.js";
import { toast } from "./toast.js";
import { $, addDays, fmtTime, pref, setPref, startOfDay } from "./util.js";

const CATS = { restorative: "Restorative", newHobby: "New hobby", social: "Social", outdoors: "Outdoors", food: "Food" };
const FILTERS = [["all", "All"], ["restorative", "Restorative"], ["newHobby", "New hobby"], ["social", "Social"], ["sister", "With sister"]];
const OUTING_MIN = { restorative: 90 };   // minutes to set aside; everything else gets 2 hours

// Real places near Pennington/Ewing. Hours change, so every one says to check first.
const SAMPLES = [
  { title: "Walk the Watershed trails", category: "restorative", place: "The Watershed Institute", address: "31 Titus Mill Rd, Pennington, NJ",
    lat: 40.36, lon: -74.77, sisterFriendly: true, cost: "Free", notes: "Quiet woodland and meadow trails. Good for clearing your head." },
  { title: "Try bouldering", category: "newHobby", place: "Rockville Climbing Center", address: "Hamilton, NJ",
    lat: 40.23, lon: -74.67, sisterFriendly: true, cost: "Day pass + shoe rental", notes: "Beginner-friendly walls. Staff show you the basics." },
  { title: "Bowling night", category: "social", place: "Colonial Bowling & Entertainment", address: "Lawrenceville, NJ",
    lat: 40.28, lon: -74.70, sisterFriendly: true, cost: "Per game", halalNote: "Snack bar food isn't certified halal. Eat before or after." },
  { title: "Pole Farm loop", category: "outdoors", place: "Mercer Meadows", address: "Lawrence Township, NJ",
    lat: 40.31, lon: -74.75, sisterFriendly: true, cost: "Free", notes: "Wide, flat paths through open fields. Nice at sunset." },
  { title: "Farm programs on a Saturday", category: "newHobby", place: "Howell Living History Farm", address: "70 Woodens Ln, Lambertville, NJ",
    lat: 40.33, lon: -74.89, sisterFriendly: true, cost: "Mostly free", notes: "Seasonal hands-on programs: planting, harvest, crafts." },
  { title: "An hour at the art museum", category: "restorative", place: "Princeton University Art Museum", address: "Princeton University, Princeton, NJ",
    lat: 40.35, lon: -74.66, sisterFriendly: true, cost: "Free", notes: "Slow, quiet rooms. Pick one gallery and take your time." },
];

const discover = { status: "none", items: [] };   // none (signed out) | loading | ready | error
let unsubscribeDiscover = null;
let wired = false;
let invite = null;   // { opener } while the invite sheet is open

// ---------------------------------------------------------------- data
function text(v, n) { return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : ""; }
function coord(v, max) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && isFinite(n) && Math.abs(n) <= max ? n : null;
}
function safeUrl(v) {
  try { const u = new URL(String(v || "")); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; } catch (e) { return ""; }
}
function when(v) {
  if (v && typeof v.toMillis === "function") return v.toMillis();
  const t = typeof v === "number" ? v : Date.parse(String(v || ""));
  return isFinite(t) ? t : null;
}
// Remote data is checked and trimmed before it reaches the screen
function clean(id, d) {
  if (!d || d.deleted === true) return null;
  const title = text(d.title, 120);
  if (!title) return null;
  return {
    id, title,
    category: CATS[d.category] ? d.category : "",
    place: text(d.place, 120), address: text(d.address, 200),
    lat: coord(d.lat, 90), lon: coord(d.lon, 180),
    hours: text(d.hours, 120),
    start: when(d.suggestedStart), end: when(d.suggestedEnd),
    mapsUrl: safeUrl(d.mapsUrl), url: safeUrl(d.url),
    sisterFriendly: d.sisterFriendly === true,
    halalNote: text(d.halalNote, 200),
    notes: typeof d.notes === "string" ? d.notes.trim().slice(0, 600) : "",
    cost: text(d.cost, 60),
  };
}
function samples() { return SAMPLES.map((d, i) => clean("sample-" + i, d)).filter(Boolean); }

function startDiscover(user) {
  stopDiscover();
  discover.status = "loading";
  renderDiscover();
  const col = fb.collection(fb.db, "users", user.uid, "discover");
  unsubscribeDiscover = fb.onSnapshot(col, (snap) => {
    discover.items = snap.docs.map((d) => clean(d.id, d.data())).filter(Boolean);
    discover.status = "ready";
    renderDiscover();
  }, (e) => {
    console.warn("Couldn't load Discover ideas:", e);
    discover.status = "error";
    renderDiscover();
  });
}
function stopDiscover() {
  if (unsubscribeDiscover) unsubscribeDiscover();
  unsubscribeDiscover = null;
  discover.items = [];
  discover.status = "none";
}

// ---------------------------------------------------------------- where and when
// Travel mode's last position, else home, else Pennington. All rounded to 0.1°, so distances are rough.
function origin() {
  const pos = place("pos"), home = place("home");
  if (pos) return { at: pos, label: "Distances from where you are" };
  if (home) return { at: home, label: "Distances from home" };
  return { at: HOME_POINT, label: "Distances from Pennington" };
}
function miles(item, at) { return item.lat !== null && item.lon !== null ? km(at, item) * 0.621371 : null; }
function distText(mi) {
  if (mi === null) return "";
  return mi < 1 ? "Under 1 mi" : "About " + Math.round(mi) + " mi";
}
function mapsLink(item) {
  if (item.mapsUrl) return item.mapsUrl;
  const q = [item.place || item.title, item.address].filter(Boolean).join(", ") || (item.lat + "," + item.lon);
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}

function dayWord(ms) {
  const diff = Math.round((startOfDay(new Date(ms)) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
function slotText(s) { return dayWord(s.start) + ", " + fmtTime(s.start) + " to " + fmtTime(s.end); }

// The assistant's slot if it is still ahead, else the first free stretch in the next week that fits.
// Sundays only get restorative ideas.
function suggestSlot(item, cache) {
  const now = Date.now(), events = state.events || [];
  if (item.start && item.end > item.start && item.end > now) {
    let clash = overlapsProtected(item.start, item.end, events);
    if (!clash && isSunday(item.start) && item.category !== "restorative") clash = "Sunday rest";
    return { start: item.start, end: item.end, clash, fromDoc: true };
  }
  const mins = OUTING_MIN[item.category] || 120, today = startOfDay(new Date());
  for (let i = 0; i < 8; i++) {
    const day = addDays(today, i);
    if (isSunday(day) && item.category !== "restorative") continue;
    const key = i + ":" + mins;
    if (!cache.has(key)) cache.set(key, freeSlots(day, events, { minMinutes: mins, fromHour: 10, toHour: 21 }));
    for (const s of cache.get(key)) {
      const start = Math.ceil(s.start / 900000) * 900000;   // a quarter-hour start reads better
      if (start + mins * 60000 <= s.end) return { start, end: start + mins * 60000, clash: null, fromDoc: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------- render
function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}
function button(label, onClick) {
  const b = el("button", "nav-btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
function currentFilter() {
  const f = pref("discover-filter", "all");
  return FILTERS.some(([id]) => id === f) ? f : "all";
}
function matches(item, f) {
  if (f === "all") return true;
  if (f === "sister") return item.sisterFriendly;
  return item.category === f;
}

function renderDiscover() {
  const view = $("view-discover");
  if (!view || view.hidden) return;
  wireDiscover();
  const signedIn = !!(state.user && fb);
  const loading = signedIn && discover.status === "loading";
  const mine = discover.status === "ready" && discover.items.length > 0;
  const items = mine ? discover.items : samples();
  const from = origin(), f = currentFilter();

  $("discover-filters").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === f)));
  $("discover-where").textContent = from.label + ".";
  const label = $("discover-label");
  label.hidden = mine || loading;
  label.textContent = discover.status === "error" ? "Sample ideas · couldn't load yours" : "Sample ideas";

  const list = $("discover-list");
  list.textContent = "";
  if (loading) {
    $("discover-summary").textContent = "\u00a0";
    list.appendChild(el("p", "empty", "Loading ideas…"));
    return;
  }
  $("discover-summary").textContent = mine
    ? items.length + (items.length === 1 ? " idea" : " ideas") + ", nearest first"
    : "A few places near home to try";
  const shown = items.filter((item) => matches(item, f))
    .map((item) => ({ item, dist: miles(item, from.at) }))
    .sort((a, b) => (a.dist === null ? Infinity : a.dist) - (b.dist === null ? Infinity : b.dist));
  if (!shown.length) { list.appendChild(el("p", "empty", "Nothing here for this filter yet.")); return; }
  const cache = new Map();   // free slots per day, shared by all cards in this render
  shown.forEach(({ item, dist }) => list.appendChild(card(item, dist, suggestSlot(item, cache), signedIn)));
}

function card(item, dist, slot, canSave) {
  const c = el("article", "card disc-card");
  const top = el("div", "disc-top");
  top.append(el("span", "disc-cat", CATS[item.category] || "Idea"), el("span", "disc-dist", distText(dist)));
  c.append(top, el("h3", "disc-title", item.title));
  const where = [item.place && item.place !== item.title ? item.place : "", item.address].filter(Boolean).join(" · ");
  if (where) c.appendChild(el("p", "disc-place", where));

  const meta = el("ul", "disc-meta");
  const row = (name, value) => {
    const li = el("li");
    li.append(el("b", "", name + " "), document.createTextNode(value));
    meta.appendChild(li);
  };
  row("Hours", !item.hours ? "Check before going" : /check/i.test(item.hours) ? item.hours : item.hours + " (check before going)");
  row(slot && slot.fromDoc ? "Suggested" : "Free", slot ? slotText(slot) : "No free slot in the next week");
  if (item.cost) row("Cost", item.cost);
  c.appendChild(meta);
  if (slot && slot.clash) c.appendChild(el("p", "disc-note disc-clash", "Overlaps " + slot.clash + ". Pick another time."));

  if (item.sisterFriendly) {
    const tags = el("div", "disc-tags");
    tags.appendChild(el("span", "disc-tag", "Good with your sister"));
    c.appendChild(tags);
  }
  if (item.halalNote) c.appendChild(el("p", "disc-note", "Halal: " + item.halalNote));
  if (item.notes) c.appendChild(el("p", "disc-note", item.notes));

  const links = el("p", "disc-links");
  const link = (label, href) => {
    const a = el("a", "", label);
    a.href = href; a.target = "_blank"; a.rel = "noopener";
    links.appendChild(a);
  };
  link("Map", mapsLink(item));
  if (item.url) link("Website", item.url);
  c.appendChild(links);

  const actions = el("div", "disc-actions");
  if (canSave) actions.appendChild(button("Save to Ideas", () => saveIdea(item)));
  actions.appendChild(button("Draft invite", (e) => openInvite(item, slot, e.currentTarget)));
  actions.appendChild(button("Add to calendar", () => addToCalendar(item, slot)));
  c.appendChild(actions);
  return c;
}

// ---------------------------------------------------------------- actions
function saveIdea(item) {
  if (!state.user || !fb) { toast("Sign in to save ideas."); return; }
  const raw = item.place && !item.title.includes(item.place) ? item.title + " · " + item.place : item.title;
  const title = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (openIdeas().some((t) => t.title.toLowerCase() === title)) { toast("That's already in Ideas."); return; }
  const hasIdeas = state.lists.some((l) => l.id === IDEAS);
  if (addTask(raw, IDEAS)) toast(hasIdeas ? "Saved to Ideas" : "Saved to your to-do list");
}

function addToCalendar(item, slot) {
  if (!slot) { toast("No free time found this week. Pick a time yourself."); return; }
  const description = [
    item.notes,
    "Hours: " + (item.hours || "check before going"),
    item.halalNote ? "Halal: " + item.halalNote : "",
    "Map: " + mapsLink(item),
  ].filter(Boolean).join("\n");
  const ok = downloadIcs({
    title: item.title, start: slot.start, end: slot.end,
    location: [item.place, item.address].filter(Boolean).join(", "),
    url: item.url || mapsLink(item), description,
    uid: "discover-" + item.id + "-" + slot.start + "@homebase",
  }, item.title);
  toast(ok ? "Calendar file downloaded. Open it to add the event." : "Couldn't make the calendar file.");
}

// ---------------------------------------------------------------- invite sheet (drafts only; never sends)
function inviteText(item, slot) {
  const what = item.place && item.place !== item.title ? item.title + " at " + item.place : item.title;
  let whenText = "";
  if (slot) {
    const d = dayWord(slot.start);
    const day = d === "Today" || d === "Tomorrow" ? d.toLowerCase()
      : "on " + new Date(slot.start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    whenText = " " + day + " around " + fmtTime(slot.start);
  }
  return [
    "Hey! Want to come with me to " + what + whenText + "?",
    "Here's where it is: " + mapsLink(item),
    "Let me know if that works. I'll double-check the hours before we go.",
  ].join("\n\n");
}
function cleanPhone(v) { return String(v || "").replace(/[^\d+]/g, "").slice(0, 16); }
function updateSms() {
  const phone = cleanPhone($("invite-phone").value);
  $("invite-sms").href = "sms:" + phone + "?&body=" + encodeURIComponent($("invite-text").value);
}
function flash(id, label) {
  const b = $(id), was = b.dataset.label || b.textContent;
  b.dataset.label = was;
  b.textContent = label;
  setTimeout(() => { b.textContent = was; }, 1600);
}
function openInvite(item, slot, opener) {
  invite = { opener };
  $("invite-sub").textContent = item.title + (slot ? " · " + slotText(slot) : "");
  $("invite-text").value = inviteText(item, slot);
  $("invite-phone").value = pref("sister-phone", "");
  $("invite-share").hidden = typeof navigator.share !== "function";
  updateSms();
  $("invite-sheet").hidden = false;
  setTimeout(() => $("invite-text").focus(), 60);
}
function closeInvite() {
  $("invite-sheet").hidden = true;
  const opener = invite && invite.opener;
  invite = null;
  if (opener && opener.isConnected) opener.focus();
}
// The toast sits under sheets, so feedback in the sheet goes on the button itself
async function copyInvite() {
  const box = $("invite-text");
  try {
    await navigator.clipboard.writeText(box.value);
    flash("invite-copy", "Copied");
  } catch (e) {
    box.focus();
    box.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (x) { ok = false; }
    flash("invite-copy", ok ? "Copied" : "Select and copy");
  }
}
async function shareInvite() {
  try { await navigator.share({ text: $("invite-text").value }); }
  catch (e) { if (!e || e.name !== "AbortError") flash("invite-share", "Couldn't share"); }
}

function wireDiscover() {
  if (wired) return;
  wired = true;
  const host = $("discover-filters");
  FILTERS.forEach(([id, name]) => {
    const b = el("button", "", name);
    b.type = "button";
    b.dataset.f = id;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => { setPref("discover-filter", id); renderDiscover(); });
    host.appendChild(b);
  });
  const find = $("discover-locate");
  if (!navigator.geolocation) find.hidden = true;
  find.addEventListener("click", () => {
    find.disabled = true;
    find.textContent = "Finding you…";
    locate(null, (ok) => {
      find.disabled = false;
      find.textContent = "Use my location";
      if (!ok) toast("Couldn't get your location. Check that location is allowed.");
      renderDiscover();
    });
  });
  const sheet = $("invite-sheet");
  sheet.addEventListener("click", (e) => { if (e.target === sheet) closeInvite(); });
  $("invite-close").addEventListener("click", closeInvite);
  $("invite-text").addEventListener("input", updateSms);
  $("invite-phone").addEventListener("input", updateSms);
  $("invite-phone").addEventListener("change", () => setPref("sister-phone", cleanPhone($("invite-phone").value)));
  $("invite-copy").addEventListener("click", copyInvite);
  $("invite-share").addEventListener("click", shareInvite);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !sheet.hidden) closeInvite(); });
}

export { renderDiscover, startDiscover, stopDiscover };
