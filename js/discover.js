// ================================================================ DISCOVER
// Ideas for free time: a curated list on this device, with anything in
// users/{uid}/discover merged on top (this tab only reads that collection).
// A prompt filters the list. The draft invite is never sent by the app.
//   { title, category: "restorative"|"newHobby"|"social", companions: ["family"|"friends"|"newPeople"],
//     place, address, lat, lon, hours, suggestedStart, suggestedEnd, mapsUrl, url,
//     sisterFriendly (older docs: treated as family), halalNote, notes, cost, keywords, createdAt }
import { km } from "../theme.js";
import { SEED_IDEAS } from "./discover-ideas.js";
import { fb } from "./firebase.js";
import { downloadIcs } from "./ics.js";
import { locate, place } from "./location.js";
import { cachedPlace, driveHours, driveText, halalSearchUrl, lookupPlace, recentPlaces, tripPlan, visitSlot } from "./places.js";
import { HOME_POINT, freeSlots, isSunday, overlapsProtected } from "./protected.js";
import { state } from "./state.js";
import { IDEAS, addTask, openIdeas } from "./tasks.js";
import { toast } from "./toast.js";
import { $, addDays, fmtTime, pref, setPref, startOfDay } from "./util.js";

const CATS = { restorative: "Restorative", newHobby: "New hobby", social: "Social" };
const WITH = { family: "Family", friends: "Friends", newPeople: "New people" };
const WITH_HINT = {
  family: "Kids and older relatives, easy pace",
  friends: "Closer friends",
  newPeople: "Structured and low-pressure",
};
const CAT_FILTERS = [["all", "All"], ["restorative", "Restorative"], ["newHobby", "New hobby"], ["social", "Social"]];
const OUTING_MIN = { restorative: 90 };   // minutes to set aside; everything else gets 2 hours
const FEW = 3;                            // below this, offer Maps and Meetup links
const STOP = new Set(["a", "an", "the", "for", "with", "me", "to", "in", "near", "on", "at", "of", "and", "or", "my", "something", "some", "want", "looking"]);
// One word or phrase in the prompt also matches these, so "quiet" finds restorative ideas.
const SYNONYMS = {
  outdoors: ["park", "trail", "hike", "preserve", "towpath", "meadow", "outdoor", "woods", "garden"],
  outside: ["park", "trail", "hike", "outdoor", "woods"],
  quiet: ["restorative", "calm", "slow"],
  calm: ["restorative", "quiet"],
  kids: ["family", "children", "storytime"],
  kid: ["family", "children"],
  child: ["family", "children"],
  children: ["family"],
  parents: ["family"],
  parent: ["family"],
  grandma: ["family"],
  grandpa: ["family"],
  family: ["family"],
  friends: ["friends"],
  friend: ["friends"],
  "new people": ["newpeople", "new people"],
  meetup: ["newpeople", "club"],
  hobby: ["newhobby", "class", "learn"],
  learn: ["newhobby", "class"],
  class: ["newhobby"],
  social: ["social"],
  food: ["halal", "restaurant", "market"],
  halal: ["halal"],
  queens: ["queens", "jamaica", "flushing"],
};

const discover = { status: "none", items: [] };   // none (signed out) | loading | ready | error
const trip = { status: "idle", query: "", place: null, ideas: [], error: "" };   // Somewhere else
let unsubscribeDiscover = null;
let wired = false;
let invite = null;   // { opener } while the invite sheet is open
let micRec = null;
let lookupGen = 0;
let lookupTimer = 0;

function currentMode() { return pref("discover-mode", "near") === "away" ? "away" : "near"; }

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
function categoryOf(c) {
  if (c === "outdoors") return "restorative";
  if (c === "food") return "social";
  return CATS[c] ? c : "";
}
function companionsOf(d) {
  const out = [];
  const add = (id) => { if (WITH[id] && !out.includes(id)) out.push(id); };
  if (Array.isArray(d.companions)) d.companions.forEach((id) => add(typeof id === "string" ? id : ""));
  Object.keys(WITH).forEach((id) => { if (d[id] === true) add(id); });
  if (d.sisterFriendly === true) add("family");   // older docs used this for a family outing
  return out;
}
// Remote data is checked and trimmed before it reaches the screen
function clean(id, d) {
  if (!d || d.deleted === true) return null;
  const title = text(d.title, 120);
  if (!title) return null;
  let keywords = text(d.keywords, 240);
  if (d.category === "outdoors") keywords = (keywords + " outdoors park trail").trim();
  if (d.category === "food") keywords = (keywords + " food").trim();
  return {
    id, title,
    category: categoryOf(d.category),
    companions: companionsOf(d),
    place: text(d.place, 120), address: text(d.address, 200),
    lat: coord(d.lat, 90), lon: coord(d.lon, 180),
    hours: text(d.hours, 160),
    start: when(d.suggestedStart), end: when(d.suggestedEnd),
    mapsUrl: safeUrl(d.mapsUrl), url: safeUrl(d.url),
    halalNote: text(d.halalNote, 240),
    notes: typeof d.notes === "string" ? d.notes.trim().slice(0, 600) : "",
    cost: text(d.cost, 80),
    keywords,
  };
}
function seeds() { return SEED_IDEAS.map((d) => clean(d.id, d)).filter(Boolean); }
// The seed list is the base. A saved idea with the same title replaces that seed; anything else is added.
function ideaList() {
  const map = new Map();
  seeds().forEach((item) => map.set(item.title.toLowerCase(), item));
  discover.items.forEach((item) => map.set(item.title.toLowerCase(), item));
  return [...map.values()];
}

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
function distText(mi, fromCenter) {
  if (mi === null || !isFinite(mi)) return "";
  const n = mi < 1 ? "Under 1 mi" : "About " + Math.round(mi) + " mi";
  return fromCenter ? n + " from the center" : n;
}
function mapsLink(item) {
  if (item.mapsUrl) return item.mapsUrl;
  const q = [item.place || item.title, item.address].filter(Boolean).join(", ") || (item.lat + "," + item.lon);
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
}
// Queens when he is actually over there; otherwise searches stay around Pennington.
function searchNear(at) {
  if (at && at.lat > 40.55 && at.lon > -74.05) return { name: "Jamaica, Queens, NY", meetup: "us--ny--Queens" };
  return { name: "Pennington, NJ", meetup: "us--nj--Princeton" };
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
    if (!clash) {
      // The assistant's slot must also miss his calendar (classes, appointments), not just the protected blocks
      const hit = events.find((ev) => ev && !ev.allDay && isFinite(ev.startMs) && isFinite(ev.endMs) && ev.startMs < item.end && ev.endMs > item.start);
      if (hit) clash = typeof hit.title === "string" && hit.title.trim() ? hit.title.trim().slice(0, 80) : "a calendar event";
    }
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

// ---------------------------------------------------------------- filters and the prompt
function currentCategory() {
  let f = pref("discover-filter", "all");
  if (f === "sister") {   // the old "With sister" chip
    if (!pref("discover-with", "")) setPref("discover-with", "family");
    setPref("discover-filter", "all");
    f = "all";
  }
  return CAT_FILTERS.some(([id]) => id === f) ? f : "all";
}
function currentWith() {
  const w = pref("discover-with", "");
  return WITH[w] ? w : "";
}
function queryText() {
  const box = $("discover-q");
  return box ? box.value.replace(/\s+/g, " ").trim().slice(0, 120) : "";
}
function queryGroups(q) {
  let rest = q.toLowerCase();
  const groups = [];
  Object.keys(SYNONYMS).filter((k) => k.includes(" ")).sort((a, b) => b.length - a.length).forEach((phrase) => {
    if (rest.includes(phrase)) {
      groups.push([phrase.replace(/\s+/g, ""), ...SYNONYMS[phrase]]);
      rest = rest.split(phrase).join(" ");
    }
  });
  rest.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).forEach((w) => {
    groups.push([w, ...(SYNONYMS[w] || [])]);
  });
  return groups;
}
function haystack(item) {
  return [
    item.title, item.notes, item.place, item.address, item.hours, item.cost, item.halalNote, item.keywords,
    item.category, CATS[item.category] || "",
    ...item.companions, ...item.companions.map((id) => WITH[id] || ""),
  ].filter(Boolean).join(" ").toLowerCase();
}
function matchesQuery(item, groups) {
  if (!groups.length) return true;
  const hay = haystack(item);
  return groups.every((alts) => alts.some((a) => hay.includes(a)));
}
function matches(item, cat, who, groups) {
  if (cat !== "all" && item.category !== cat) return false;
  if (who && !item.companions.includes(who)) return false;
  return matchesQuery(item, groups);
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
function anchor(label, href) {
  const a = el("a", "", label);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function renderDiscover() {
  const view = $("view-discover");
  if (!view || view.hidden) return;
  wireDiscover();
  const signedIn = !!(state.user && fb);
  const away = currentMode() === "away";
  const cat = currentCategory(), who = currentWith();
  $("discover-filters").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === cat)));
  $("discover-with").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.w === who)));
  const nearBtn = $("discover-near"), awayBtn = $("discover-away");
  if (nearBtn) nearBtn.setAttribute("aria-pressed", String(!away));
  if (awayBtn) awayBtn.setAttribute("aria-pressed", String(away));
  const box = $("discover-q");
  if (box) box.placeholder = away ? "A city or state, e.g. Philadelphia or Vermont" : "A quiet walk, something outdoors, time with family…";
  const locate = $("discover-locate");
  if (locate && locate.dataset.wired) locate.hidden = away || !navigator.geolocation;
  renderRecent(away);
  if (away) { renderAway(signedIn, cat, who); return; }

  const items = ideaList();
  const from = origin();
  const q = queryText(), groups = queryGroups(q);
  $("discover-where").textContent = from.label + ".";
  const label = $("discover-label");
  if (discover.status === "error") { label.hidden = false; label.textContent = "Couldn't load your saved ideas"; }
  else if (discover.status === "ready" && discover.items.length) { label.hidden = false; label.textContent = "Your saved ideas are included"; }
  else { label.hidden = true; label.textContent = ""; }

  const list = $("discover-list");
  list.textContent = "";
  const shown = items.filter((item) => matches(item, cat, who, groups))
    .map((item) => ({ item, dist: miles(item, from.at) }))
    .sort((a, b) => (a.dist === null ? Infinity : a.dist) - (b.dist === null ? Infinity : b.dist));
  $("discover-summary").textContent = shown.length + (shown.length === 1 ? " idea" : " ideas") + ", nearest first";
  if (!shown.length) list.appendChild(el("p", "empty", q ? "Nothing in the list matches that." : "Nothing here for this filter yet."));
  const cache = new Map();   // free slots per day, shared by all cards in this render
  shown.forEach(({ item, dist }) => list.appendChild(card(item, dist, suggestSlot(item, cache), signedIn, who, false)));
  if (q && shown.length < FEW) list.appendChild(nearbyCard(q, from.at));
}

function renderRecent(away) {
  const host = $("discover-recent");
  if (!host) return;
  host.textContent = "";
  if (!away) { host.hidden = true; return; }
  const names = recentPlaces().filter((name) => name.toLowerCase() !== queryText().toLowerCase());
  host.hidden = names.length === 0;
  names.forEach((name) => {
    const b = el("button", "nav-btn", name);
    b.type = "button";
    b.addEventListener("click", () => {
      const box = $("discover-q");
      if (box) box.value = name;
      onPrompt(true);
    });
    host.appendChild(b);
  });
}

function renderAway(signedIn, cat, who) {
  const place = trip.place;
  const label = $("discover-label");
  label.hidden = true;
  $("discover-where").textContent = place ? "Ideas around " + place.name + "." : "A trip from Pennington. Drive time is a straight-line estimate.";
  const list = $("discover-list");
  list.textContent = "";
  if (trip.status === "loading") {
    $("discover-summary").textContent = "Looking up " + trip.query + "…";
    list.appendChild(el("p", "empty", "Asking OpenStreetMap and Wikipedia. One search at a time."));
    return;
  }
  if (trip.status === "error") {
    $("discover-summary").textContent = "Couldn't look that up";
    list.appendChild(el("p", "empty", trip.error === "busy"
      ? "The map search is busy. Wait a moment, then try again."
      : trip.error === "none"
        ? "No place found with that name. Try a city or a state."
        : "Couldn't reach the map or Wikipedia. Check your connection and try again."));
    return;
  }
  if (!place) {
    $("discover-summary").textContent = "Somewhere else";
    list.appendChild(el("p", "empty", "Type a city or a state. Homebase looks up real Wikipedia pages there. It does not invent places."));
    return;
  }
  const plan = tripPlan(state.events || []);
  const shown = trip.ideas.filter((item) => matches(item, cat, who, []))
    .map((item) => ({ item, dist: miles(item, place) }))
    .sort((a, b) => (a.dist === null ? Infinity : a.dist) - (b.dist === null ? Infinity : b.dist));
  $("discover-summary").textContent = shown.length + (shown.length === 1 ? " place" : " places") + " near " + place.name;
  list.appendChild(tripBanner(place, plan, shown.length));
  if (!shown.length) list.appendChild(el("p", "empty", trip.ideas.length ? "Nothing here for this filter." : "Wikipedia had no parks, museums, or similar pages to show for that spot."));
  shown.forEach(({ item, dist }) => list.appendChild(card(item, dist, visitSlot(item, plan, place), signedIn, who, true)));
  const credit = el("p", "disc-credit", "Places, descriptions, and photos are from Wikipedia and Wikimedia Commons, only when a page has them. The point on the map is from OpenStreetMap, via Nominatim. Nothing here is a rating or a halal certification.");
  list.appendChild(credit);
}

function tripBanner(place, plan, count) {
  const box = el("div", "card disc-trip");
  box.appendChild(el("h3", "disc-title", place.name));
  const where = el("p", "disc-place", place.wide
    ? "A whole state is bigger than one search. These are Wikipedia pages inside it, nearest the center first. Wikipedia's own nearby search only covers about 6 miles."
    : "Wikipedia pages within about 6 miles of the center, plus a few well-known ones a little farther out.");
  box.appendChild(where);
  box.appendChild(el("p", "disc-note", driveText(place)));
  box.appendChild(el("p", "disc-note", planText(plan, place)));
  const links = el("p", "disc-links");
  const halal = anchor("Search zabiha halal near " + place.name, halalSearchUrl(place.name));
  links.appendChild(halal);
  box.appendChild(links);
  box.appendChild(el("p", "disc-note", "That search does not mean any restaurant is halal. Check for yourself."));
  return box;
}
function planText(plan, place) {
  const far = driveHours(place) > 3;
  const rest = " Sunday stays a rest day, so nothing is planned then.";
  if (!plan) return "No open stretch in the next three weeks once protected blocks and your calendar are taken out." + rest;
  const when = plan.day.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const window = fmtTime(plan.slot.start) + " to " + fmtTime(plan.slot.end);
  const day = plan.saturday ? when + " is open " + window + ", after protected blocks and anything already on the calendar."
    : "No free Saturday in the next three weeks. " + when + " is open " + window + ".";
  return day + (far ? " The straight-line drive is long, so this is not a casual day trip." : "") + rest;
}

function photoBlock(item) {
  if (!item.photo) return el("div", "disc-photo disc-photo-empty", "No photo on Wikipedia");
  const img = document.createElement("img");
  img.className = "disc-photo";
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.src = item.photo;
  img.addEventListener("error", () => {
    const ph = el("div", "disc-photo disc-photo-empty", "No photo on Wikipedia");
    if (img.parentNode) img.replaceWith(ph);
  });
  return img;
}
function openPlace(item) {
  const href = item.officialUrl || item.mapsUrl || mapsLink(item);
  const opened = window.open(href, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}
function card(item, dist, slot, canSave, who, fromCenter) {
  const linked = "photo" in item;
  const c = el("article", "card disc-card" + (linked ? " is-link" : ""));
  if (linked) {
    const site = !!item.officialUrl;
    c.tabIndex = 0;
    c.setAttribute("role", "link");
    c.setAttribute("aria-label", (site ? "Website" : "Maps") + ": " + item.title);
    c.addEventListener("click", (e) => {
      if (e.target.closest("a, button, .disc-actions, .disc-tags")) return;
      openPlace(item);
    });
    c.addEventListener("keydown", (e) => {
      if (e.target !== c || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      openPlace(item);
    });
  }
  if ("photo" in item) c.appendChild(photoBlock(item));
  const top = el("div", "disc-top");
  top.append(el("span", "disc-cat", CATS[item.category] || "Idea"), el("span", "disc-dist", distText(dist, fromCenter)));
  c.append(top);
  if (linked) c.appendChild(el("p", "disc-go", item.officialUrl ? "Website" : "Maps"));
  c.append(el("h3", "disc-title", item.title));
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

  if (item.companions.length) {
    const tags = el("div", "disc-tags");
    item.companions.forEach((id) => {
      const tag = el("span", "disc-tag", WITH[id]);
      if (WITH_HINT[id]) tag.title = WITH_HINT[id];
      tags.appendChild(tag);
    });
    c.appendChild(tags);
  }
  if (item.halalNote) c.appendChild(el("p", "disc-note", "Halal: " + item.halalNote));
  if (item.notes) c.appendChild(el("p", "disc-note", item.notes));

  const links = el("p", "disc-links");
  links.appendChild(anchor("Map", mapsLink(item)));
  if (item.url) links.appendChild(anchor(item.sourceName || "Website", item.url));
  c.appendChild(links);

  const actions = el("div", "disc-actions");
  if (canSave) actions.appendChild(button("Save to Ideas", () => saveIdea(item)));
  actions.appendChild(button("Draft invite", (e) => openInvite(item, slot, who, e.currentTarget)));
  actions.appendChild(button("Add to calendar", () => addToCalendar(item, slot)));
  c.appendChild(actions);
  return c;
}

function nearbyCard(q, at) {
  const here = searchNear(at);
  const box = el("div", "card disc-nearby");
  box.appendChild(el("h3", "disc-title", "Search nearby"));
  box.appendChild(el("p", "disc-note", "Not many ideas here match. These open a search for “" + q.slice(0, 80) + "” near " + here.name + ". Homebase does not run the search."));
  const links = el("p", "disc-links");
  links.append(
    anchor("Google Maps", "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q + " near " + here.name)),
    anchor("Meetup", "https://www.meetup.com/find/?keywords=" + encodeURIComponent(q) + "&source=EVENTS&location=" + encodeURIComponent(here.meetup)),
  );
  box.appendChild(links);
  return box;
}

// ---------------------------------------------------------------- actions
function saveIdea(item) {
  if (!state.user || !fb) { toast("Sign in to save ideas."); return; }
  const raw = (item.place && !item.title.includes(item.place) ? item.title + " · " + item.place : item.title).slice(0, 200);   // MAX_TITLE
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
function chosenCompanion(item, who) {
  if (who && WITH[who]) return who;
  if (item.companions.length === 1) return item.companions[0];
  return "";
}
function inviteText(item, slot, who) {
  const what = item.place && item.place !== item.title ? item.title + " at " + item.place : item.title;
  let whenText = "";
  if (slot) {
    const d = dayWord(slot.start);
    const day = d === "Today" || d === "Tomorrow" ? d.toLowerCase()
      : "on " + new Date(slot.start).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    whenText = " " + day + " around " + fmtTime(slot.start);
  }
  const lead = who === "family"
    ? "Want to come with me to " + what + whenText + "? It's an easy pace, fine for kids and older relatives."
    : who === "friends"
      ? "Want to come with me to " + what + whenText + "?"
      : who === "newPeople"
        ? "I'm thinking of going to " + what + whenText + ". Want to join? It's low-pressure, and the plan is already set."
        : "Want to come with me to " + what + whenText + "?";
  return [
    lead,
    "Here's where it is: " + mapsLink(item),
    "I'll double-check the hours before we go. Nothing is sent until you send this yourself.",
  ].join("\n\n");
}
function cleanPhone(v) { return String(v || "").replace(/[^\d+]/g, "").slice(0, 16); }
function savedPhone() { return pref("invite-phone", "") || pref("sister-phone", ""); }
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
function openInvite(item, slot, filteredWith, opener) {
  const who = chosenCompanion(item, filteredWith);
  invite = { opener };
  $("invite-title").textContent = who === "family" ? "Invite family" : who === "friends" ? "Invite friends" : who === "newPeople" ? "Invite someone new" : "Draft an invite";
  $("invite-who").textContent = who === "family" ? "A family number" : who === "friends" ? "A friend's number" : "Their number";
  $("invite-sub").textContent = item.title + (slot ? " · " + slotText(slot) : "");
  $("invite-text").value = inviteText(item, slot, who);
  $("invite-phone").value = savedPhone();
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

function stopMic() {
  const rec = micRec;
  micRec = null;
  if (rec) { try { rec.onend = null; rec.stop(); } catch (e) { /* already stopped */ } }
  const mic = $("discover-mic");
  if (mic) { mic.setAttribute("aria-pressed", "false"); mic.textContent = "Mic"; }
}
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $("discover-mic");
  if (!SR || !mic) return;
  stopMic();
  let rec;
  try { rec = new SR(); } catch (e) { toast("Speaking isn't available here. Type instead."); return; }
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => {
    const said = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript;
    if (!said) return;
    const box = $("discover-q");
    if (box) box.value = said;
    onPrompt(true);
  };
  rec.onerror = (e) => {
    if (!e || e.error === "aborted" || e.error === "no-speech") return;
    toast(e.error === "not-allowed" ? "Microphone is blocked. You can still type." : "Couldn't hear that. Try typing.");
  };
  rec.onend = () => { if (micRec === rec) stopMic(); };
  micRec = rec;
  mic.setAttribute("aria-pressed", "true");
  mic.textContent = "Stop";
  try { rec.start(); }
  catch (e) { stopMic(); toast("Speaking isn't available here. Type instead."); }
}

function setMode(mode) {
  setPref("discover-mode", mode === "away" ? "away" : "near");
  lookupGen++;
  clearTimeout(lookupTimer);
  if (mode === "away") {
    const box = $("discover-q");
    const saved = pref("discover-dest", "");
    if (box && !box.value.trim() && saved) box.value = saved;
    runLookup();
  } else renderDiscover();
}
function onPrompt(immediate) {
  if (currentMode() !== "away") { renderDiscover(); return; }
  clearTimeout(lookupTimer);
  if (immediate) runLookup();
  else lookupTimer = setTimeout(runLookup, 800);
}
async function runLookup() {
  const q = queryText();
  const gen = ++lookupGen;
  if (currentMode() !== "away") return;
  if (q.length < 2) {
    trip.status = "idle"; trip.query = ""; trip.place = null; trip.ideas = []; trip.error = "";
    renderDiscover();
    return;
  }
  const hit = cachedPlace(q);
  if (hit) {
    trip.status = "ready"; trip.query = q; trip.place = hit.place; trip.ideas = hit.ideas; trip.error = "";
    setPref("discover-dest", hit.place.name);
    renderDiscover();
    return;
  }
  trip.status = "loading"; trip.query = q; trip.place = null; trip.ideas = []; trip.error = "";
  renderDiscover();
  try {
    const result = await lookupPlace(q);
    if (gen !== lookupGen || currentMode() !== "away") return;
    if (result.error) {
      trip.status = "error"; trip.error = result.error; trip.place = null; trip.ideas = [];
    } else {
      trip.status = "ready"; trip.place = result.place; trip.ideas = result.ideas; trip.error = "";
      setPref("discover-dest", result.place.name);
    }
  } catch (e) {
    if (gen !== lookupGen || currentMode() !== "away") return;
    trip.status = "error"; trip.error = e && e.code === "busy" ? "busy" : "network"; trip.place = null; trip.ideas = [];
  }
  renderDiscover();
}

function wireDiscover() {
  if (wired) return;
  wired = true;
  const cats = $("discover-filters");
  CAT_FILTERS.forEach(([id, name]) => {
    const b = el("button", "", name);
    b.type = "button";
    b.dataset.f = id;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => { setPref("discover-filter", id); renderDiscover(); });
    cats.appendChild(b);
  });
  const withRow = $("discover-with");
  Object.keys(WITH).forEach((id) => {
    const b = el("button", "", WITH[id]);
    b.type = "button";
    b.dataset.w = id;
    b.title = WITH_HINT[id];
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      setPref("discover-with", currentWith() === id ? "" : id);   // tap again to clear
      renderDiscover();
    });
    withRow.appendChild(b);
  });
  const form = $("discover-ask");
  form.addEventListener("submit", (e) => { e.preventDefault(); onPrompt(true); });
  $("discover-q").addEventListener("input", () => onPrompt(false));
  $("discover-near").addEventListener("click", () => setMode("near"));
  $("discover-away").addEventListener("click", () => setMode("away"));
  const mic = $("discover-mic");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) mic.hidden = true;
  else {
    mic.hidden = false;
    mic.addEventListener("click", () => { if (micRec) stopMic(); else startMic(); });
  }
  const find = $("discover-locate");
  find.dataset.wired = "1";
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
  $("invite-phone").addEventListener("change", () => setPref("invite-phone", cleanPhone($("invite-phone").value)));
  $("invite-copy").addEventListener("click", copyInvite);
  $("invite-share").addEventListener("click", shareInvite);
  document.addEventListener("keydown", (e) => {
    if (sheet.hidden) return;
    if (e.key === "Escape") { closeInvite(); return; }
    if (e.key !== "Tab") return;
    // aria-modal: keep Tab and Shift+Tab inside the sheet
    const f = [...sheet.querySelectorAll("button, a[href], textarea, input")]
      .filter((n) => !n.disabled && n.getClientRects().length > 0);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], active = document.activeElement;
    if (!sheet.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  });
}

export { renderDiscover, startDiscover, stopDiscover };
