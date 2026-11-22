// Destination lookup for Discover. No API key: Nominatim for the city or state,
// then Wikipedia for real pages near that point (photos come only from Wikimedia).
// Nominatim's policy: one search at a time, no faster than about once a second, and a cache.
import { km } from "../theme.js";
import { HOME_POINT, freeSlots, isSunday } from "./protected.js";
import { addDays, pref, setPref, startOfDay } from "./util.js";

const CACHE_KEY = "place-cache-v2";
const SITE_KEY = "place-sites-v1";
const MAX_SAVED = 8;
const GEO_GAP_MS = 1100;
const WIKI = "https://en.wikipedia.org/w/api.php";
const WIKIDATA = "https://www.wikidata.org/w/api.php";

let lastGeoAt = 0;

function readCache() {
  try {
    const raw = JSON.parse(pref(CACHE_KEY, ""));
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) { return {}; }
}
function writeCache(all) {
  const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_SAVED);
  try { setPref(CACHE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch (e) { /* the list still works this session */ }
}
function cacheKey(q) { return q.toLowerCase(); }

export function cachedPlace(q) {
  const hit = readCache()[cacheKey(q)];
  return hit && hit.place && Array.isArray(hit.ideas) ? hit : null;
}
export function recentPlaces() {
  return Object.entries(readCache())
    .filter(([, v]) => v && v.place && v.place.name)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, 6)
    .map(([, v]) => v.place.name);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function geocode(q) {
  const wait = GEO_GAP_MS - (Date.now() - lastGeoAt);
  if (wait > 0) await sleep(wait);
  lastGeoAt = Date.now();
  const params = { q, format: "jsonv2", limit: "1", addressdetails: "1" };
  if (!q.includes(",")) params.countrycodes = "us";   // "Vermont" should not land on a namesake abroad
  const res = await fetch("https://nominatim.openstreetmap.org/search?" + new URLSearchParams(params), {
    headers: { "Accept": "application/json" },
  });
  if (res.status === 429) { const err = new Error("busy"); err.code = "busy"; throw err; }
  if (!res.ok) { const err = new Error("geo"); err.code = "network"; throw err; }
  const data = await res.json();
  const d = data && data[0];
  if (!d || !isFinite(parseFloat(d.lat)) || !isFinite(parseFloat(d.lon))) return null;
  const bbox = (d.boundingbox || []).map(Number);
  const span = bbox.length === 4 ? Math.max(bbox[1] - bbox[0], bbox[3] - bbox[2]) : 0;
  const wide = d.addresstype === "state" || span > 0.8;
  return {
    name: d.name || String(d.display_name || q).split(",")[0],
    label: d.display_name || d.name || q,
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    wide,
    bbox: bbox.length === 4 ? bbox : null,
  };
}

function wikiUrl(params) {
  return WIKI + "?" + new URLSearchParams({
    action: "query", format: "json", origin: "*",
    prop: "pageimages|extracts|coordinates|info|pageprops",
    inprop: "url", ppprop: "wikibase_item", exintro: "1", explaintext: "1", exchars: "280",
    pithumbsize: "480", piprop: "thumbnail",
    ...params,
  });
}
async function wiki(params) {
  const res = await fetch(wikiUrl(params));
  if (!res.ok) { const err = new Error("wiki"); err.code = "network"; throw err; }
  const data = await res.json();
  const pages = data && data.query && data.query.pages;
  return pages ? Object.values(pages) : [];
}

function safePhoto(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:") return "";
    if (!/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/.test(u.hostname)) return "";
    return u.href;
  } catch (e) { return ""; }
}
function safeSite(url) {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.href;
  } catch (e) { return ""; }
}
function readSites() {
  try {
    const raw = JSON.parse(pref(SITE_KEY, ""));
    return raw && typeof raw === "object" ? raw : {};
  } catch (e) { return {}; }
}
function writeSites(all) {
  const entries = Object.entries(all).slice(-300);
  try { setPref(SITE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch (e) { /* a miss just means Maps */ }
}
// P856 is the official website. Preferred rank wins. An empty string means Wikidata has none.
function siteFromEntity(entity) {
  const claims = entity && entity.claims && entity.claims.P856 || [];
  const ranked = claims.filter((c) => c && c.rank !== "deprecated" && c.mainsnak && c.mainsnak.snaktype === "value");
  ranked.sort((a, b) => (a.rank === "preferred" ? 0 : 1) - (b.rank === "preferred" ? 0 : 1));
  for (const c of ranked) {
    const value = c.mainsnak.datavalue && c.mainsnak.datavalue.value;
    const url = safeSite(typeof value === "string" ? value : "");
    if (url) return url;
  }
  return "";
}
async function attachWebsites(ideas) {
  const ids = [...new Set(ideas.map((i) => i.qid).filter((id) => /^Q\d+$/.test(id)))];
  const known = readSites();
  const missing = ids.filter((id) => !Object.prototype.hasOwnProperty.call(known, id));
  if (missing.length) {
    try {
      const res = await fetch(WIKIDATA + "?" + new URLSearchParams({
        action: "wbgetentities", ids: missing.join("|"), props: "claims", format: "json", origin: "*",
      }));
      if (res.ok) {
        const data = await res.json();
        const entities = data && data.entities || {};
        missing.forEach((id) => { known[id] = siteFromEntity(entities[id]); });
        writeSites(known);
      }
    } catch (e) { /* no official site this time; the card opens Maps */ }
  }
  ideas.forEach((idea) => {
    idea.officialUrl = safeSite(known[idea.qid] || "");
  });
}
function safeWiki(url) {
  try {
    const u = new URL(String(url || ""));
    return u.protocol === "https:" && /(^|\.)wikipedia\.org$/.test(u.hostname) ? u.href : "";
  } catch (e) { return ""; }
}

// Only pages whose own text says what kind of outing they are. Anything else is left out.
function classify(title, extract) {
  const text = (title + " " + (extract || "")).toLowerCase();
  const has = (words) => words.some((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(text));
  if (has(["park", "garden", "trail", "forest", "woods", "lake", "river", "beach", "preserve", "wildlife", "arboretum", "waterfall", "zoo", "aquarium"]))
    return { category: "restorative", companions: ["family", "friends"] };
  if (has(["museum", "gallery", "library", "historic", "monument", "memorial", "academy", "observatory", "science center", "art museum"]))
    return { category: "newHobby", companions: ["family", "friends", "newPeople"] };
  if (has(["theatre", "theater", "music hall", "stadium", "market", "opera", "arena", "festival", "concert hall"]))
    return { category: "social", companions: ["friends", "newPeople"] };
  return null;
}
function skipPage(title, extract, place) {
  if (!title) return true;
  if (title.toLowerCase() === place.name.toLowerCase()) return true;
  if (/representative district|electoral district|disambiguation|^list of\b|census/i.test(title)) return true;
  const lead = (extract || "").slice(0, 240).toLowerCase();
  if (/\bis an? (town|city|village|borough|census|county|state|neighborhood|unincorporated|hamlet|township|suburb)\b/.test(lead)) return true;
  if (/\b(rapid transit|railway|railroad|metro) station\b|\bis a station\b/.test(lead)) return true;
  return false;
}
function inArea(lat, lon, place) {
  if (place.wide && place.bbox) {
    const [south, north, west, east] = place.bbox;
    return lat >= south && lat <= north && lon >= west && lon <= east;
  }
  return km(place, { lat, lon }) <= 30;
}
function toIdea(page, place, loose) {
  const title = page && page.title;
  const extract = typeof page.extract === "string" ? page.extract.replace(/\s+/g, " ").trim() : "";
  const coord = (page.coordinates || []).find((c) => c && c.globe === "earth" && isFinite(c.lat) && isFinite(c.lon));
  if (!coord || skipPage(title, extract, place) || (!loose && !inArea(coord.lat, coord.lon, place))) return null;
  const kind = classify(title, extract);
  if (!kind) return null;
  const url = safeWiki(page.fullurl);
  if (!url) return null;
  return {
    id: "wiki-" + page.pageid,
    title: title.slice(0, 120),
    category: kind.category,
    companions: kind.companions,
    place: place.name,
    address: "",
    lat: coord.lat,
    lon: coord.lon,
    hours: "",
    notes: extract.slice(0, 280),
    url,
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(coord.lat + "," + coord.lon),
    keywords: (title + " " + extract).slice(0, 240),
    photo: safePhoto(page.thumbnail && page.thumbnail.source),
    sourceName: "Wikipedia",
    qid: page.pageprops && /^Q\d+$/.test(page.pageprops.wikibase_item) ? page.pageprops.wikibase_item : "",
    officialUrl: "",
  };
}

export async function lookupPlace(raw) {
  const q = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (q.length < 2) return { error: "short" };
  const hit = cachedPlace(q);
  if (hit) return { place: hit.place, ideas: hit.ideas, cached: true };
  const place = await geocode(q);
  if (!place) return { error: "none" };
  const geoPages = await wiki({
    generator: "geosearch",
    ggscoord: place.lat + "|" + place.lon,
    ggsradius: "10000",
    ggslimit: "20",
  });
  let pages = geoPages;
  const kept = geoPages.map((p) => toIdea(p, place)).filter(Boolean);
  // A state is bigger than Wikipedia's 10 km geosearch, so one text search fills in named parks and museums inside the state.
  if (place.wide || kept.length < 8) {
    const search = await wiki({
      generator: "search",
      gsrsearch: place.wide
        ? place.name + " state park OR museum OR historic site"
        : place.name + " museum OR park OR garden OR historic site OR library",
      gsrlimit: "15",
      gsrnamespace: "0",
    });
    pages = geoPages.concat(search);
  }
  const seen = new Set();
  const ideas = [];
  pages.forEach((p) => {
    const idea = toIdea(p, place);
    if (!idea || seen.has(idea.id)) return;
    seen.add(idea.id);
    ideas.push(idea);
  });
  ideas.sort((a, b) => km(place, a) - km(place, b));
  const trimmed = ideas.slice(0, 18);
  await attachWebsites(trimmed);   // one Wikidata call for every page in this search
  const packed = { place, ideas: trimmed, at: Date.now() };
  const all = readCache();
  all[cacheKey(q)] = packed;
  all[cacheKey(place.name)] = packed;
  writeCache(all);
  return { place, ideas: trimmed, cached: false };
}

// Straight-line only. 50 mph is a rough clock, not a route.
export function driveText(place) {
  if (!place) return "";
  const miles = km(HOME_POINT, place) * 0.621371;
  const hours = miles / 50;
  let clock;
  if (hours < 1) clock = Math.max(10, Math.round(hours * 60 / 10) * 10) + " minutes";
  else {
    const q = Math.round(hours * 2) / 2;
    clock = q + (q === 1 ? " hour" : " hours");
  }
  return "About " + Math.round(miles) + " miles in a straight line from Pennington. At 50 mph that is roughly " + clock + " each way. Real roads take longer.";
}
export function driveHours(place) {
  if (!place) return 0;
  return km(HOME_POINT, place) * 0.621371 / 50;
}

// Next open stretch that misses protected blocks and the calendar. Saturdays first. Sundays are rest, so they are skipped.
export function tripPlan(events) {
  const today = startOfDay(new Date());
  const open = [];
  for (let i = 0; i < 21; i++) {
    const day = addDays(today, i);
    if (isSunday(day)) continue;
    const slots = freeSlots(day, events || [], { minMinutes: 240, fromHour: 9, toHour: 20 });
    if (!slots.length) continue;
    open.push({ day, slot: slots[0], saturday: day.getDay() === 6 });
  }
  return open.find((d) => d.saturday) || open[0] || null;
}

// A visit on the open day, pushed back by the straight-line drive. If the drive does not fit, say so.
export function visitSlot(item, plan, place) {
  if (!plan || !place) return null;
  const driveMs = driveHours(place) * 3600000;
  const mins = item && item.category === "restorative" ? 90 : 120;
  const start = Math.ceil((plan.slot.start + driveMs) / 900000) * 900000;
  const end = start + mins * 60000;
  if (end <= plan.slot.end) return { start, end, clash: null, fromDoc: false };
  return {
    start: plan.slot.start,
    end: Math.min(plan.slot.end, plan.slot.start + mins * 60000),
    clash: "The straight-line drive is about " + (driveHours(place) < 1 ? "under an hour" : Math.round(driveHours(place)) + " hours") + ", so this may not fit in one day.",
    fromDoc: false,
  };
}

export function halalSearchUrl(name) {
  return "https://www.google.com/search?q=" + encodeURIComponent("zabiha halal near " + (name || ""));
}

const SPOT_ORIGIN = "https://maquresh25-hub.github.io/homebase/#discover/spot?";

function num(v, max) {
  const n = parseFloat(v);
  return typeof n === "number" && isFinite(n) && Math.abs(n) <= max ? n : null;
}
function pageIdOf(item) {
  const id = String(item && item.id || "").replace(/^wiki-/, "");
  return /^\d{1,12}$/.test(id) ? id : "";
}

// A short link. The page id is enough to load the spot again; the coordinates restore the drive.
export function spotLink(item, place, query) {
  const id = pageIdOf(item);
  if (!id || !place || !isFinite(place.lat) || !isFinite(place.lon)) return "";
  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("id", id);
  params.set("q", String(query || place.name || "").replace(/\s+/g, " ").trim().slice(0, 80));
  params.set("dn", String(place.name || "").replace(/\s+/g, " ").trim().slice(0, 80));
  params.set("dlat", place.lat.toFixed(5));
  params.set("dlon", place.lon.toFixed(5));
  if (isFinite(item.lat)) params.set("lat", Number(item.lat).toFixed(5));
  if (isFinite(item.lon)) params.set("lon", Number(item.lon).toFixed(5));
  return SPOT_ORIGIN + params.toString();
}

// null when the hash is not a spot link. { bad: true } when it is a spot link we cannot use.
export function parseSpotHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (raw !== "discover/spot" && !raw.startsWith("discover/spot?")) return null;
  const q = raw.indexOf("?");
  if (q < 0) return { bad: true };
  let params;
  try { params = new URLSearchParams(raw.slice(q + 1)); } catch (e) { return { bad: true }; }
  const id = params.get("id") || "";
  const lat = num(params.get("lat"), 180);
  const lon = num(params.get("lon"), 180);
  const dlat = num(params.get("dlat"), 90);
  const dlon = num(params.get("dlon"), 180);
  const centerLat = dlat != null ? dlat : lat;
  const centerLon = dlon != null ? dlon : lon;
  const name = String(params.get("dn") || params.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!/^\d{1,12}$/.test(id) || centerLat == null || centerLon == null || Math.abs(centerLat) > 90 || !name) return { bad: true };
  return {
    id,
    query: String(params.get("q") || name).replace(/\s+/g, " ").trim().slice(0, 80),
    place: { name, lat: centerLat, lon: centerLon, wide: false, label: name },
  };
}

// Reloads one Wikipedia page by id. Nothing is stored.
export async function loadSharedSpot(spec) {
  if (!spec || spec.bad || !spec.id) return { error: "bad" };
  let pages;
  try { pages = await wiki({ pageids: spec.id }); }
  catch (e) { return { error: "network" }; }
  const page = pages.find((p) => p && p.missing == null && p.pageid);
  if (!page) return { error: "missing" };
  const idea = toIdea(page, spec.place, true);
  if (!idea) return { error: "missing" };
  await attachWebsites([idea]);
  return { place: spec.place, idea };
}
