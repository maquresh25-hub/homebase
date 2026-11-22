// ================================================================ PROTECTED BLOCKS
// The parts of Muhammad's week that suggestions (Discover now, Events next) must never land on.
// Everything here is a pure function of a date and the calendar events, so it can be checked by hand:
//   import("./js/protected.js").then((p) => console.table(p.protectedBlocks(new Date(2026, 10, 20), [])))
//
// Rules, in local time (he is in America/New_York):
//   Qur'an      every day, Fajr until 1 hour before his first class (8:00 AM if there is no class)
//   ʿAlim       Mon–Thu 9:00–11:00 AM
//   Qirat       Tue 8–9 AM, Fri 9–10 AM, Sun 9–10 AM
//   Jumuʿah     Fri 1:00–1:50 PM
//   Family time Fri from 7:30 PM to the end of the day
//   Sunday      suggestions are restorative only (isSunday; callers apply it)
import { addDays, startOfDay } from "./util.js";

const HOME_POINT = { lat: 40.30, lon: -74.81 };   // Pennington/Ewing, NJ: used for Fajr and as the default "home"
const NO_CLASS_QURAN_END = 8;                      // Qur'an runs until 8:00 AM on days without a class
const FAJR_ANGLE = 15;                             // ISNA: Fajr when the sun is 15° below the horizon

// "First class" = the earliest timed calendar event that day, at least 20 minutes long, whose title
// doesn't look like one of his own or religious blocks. A title heuristic, because the calendar
// feed has no reliable "this is a class" flag. Accents and ʿ are stripped before matching.
const NOT_CLASS = /qur|hifz|alim|qira|tajw|jum|salah|salat|prayer|fajr|dhuhr|zuhr|\basr\b|maghrib|isha|masjid|mosque|halaqa|family|sister|gym|workout|walk|lunch|dinner|breakfast|sleep|\bnaps?\b|commute|drive|study|review|homework|errand|\bpersonal|free time|idea|discover/;

function plain(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f\u02BB-\u02BF'’`]/g, "").toLowerCase();
}
function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Date.parse(String(v || ""));
}
// A clock time on that local day (setHours keeps daylight-saving days right)
function at(date, h, m) { const x = new Date(date); x.setHours(h, m || 0, 0, 0); return x.getTime(); }
function atHour(date, h) { return at(date, Math.floor(h), Math.round((h % 1) * 60)); }
function dayRange(date) {
  const s = startOfDay(date);
  return [s.getTime(), startOfDay(addDays(s, 1)).getTime()];
}
function isSunday(date) { return new Date(toMs(date)).getDay() === 0; }

// Fajr from the sun's position (the usual prayer-times formulas). Good to a few minutes.
function fajrMs(date, point) {
  const p = point && isFinite(point.lat) && isFinite(point.lon) ? point : HOME_POINT;
  const d = startOfDay(date), y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const rad = (x) => x * Math.PI / 180, deg = (x) => x * 180 / Math.PI;
  const D = Date.UTC(y, mo, day, 12) / 86400000 - 10957.5;   // days since J2000.0 (2000-01-01 12:00 UTC)
  const g = rad(357.529 + 0.98560028 * D);
  const q = 280.459 + 0.98564736 * D;
  const L = rad(q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
  const e = rad(23.439 - 0.00000036 * D);
  const decl = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = deg(Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L))) / 15;
  let eqt = q / 15 - ra;
  eqt = ((eqt % 24) + 36) % 24 - 12;                         // equation of time, hours in −12..12
  const noonUtc = 12 - eqt - p.lon / 15;                     // solar noon, UTC hours
  const lat = rad(p.lat);
  const cosT = (-Math.sin(rad(FAJR_ANGLE)) - Math.sin(decl) * Math.sin(lat)) / (Math.cos(decl) * Math.cos(lat));
  if (!(cosT >= -1 && cosT <= 1)) return at(d, 5);           // never that dark here: assume 5 AM
  return Date.UTC(y, mo, day) + (noonUtc - deg(Math.acos(cosT)) / 15) * 3600000;
}

// Timed events that touch this local day
function dayEvents(date, events) {
  const [s, e] = dayRange(date);
  return (events || []).filter((ev) => ev && !ev.allDay && isFinite(ev.startMs) && isFinite(ev.endMs) && ev.startMs < e && ev.endMs > s);
}

function firstClass(date, events) {
  const [s] = dayRange(date);
  return dayEvents(date, events)
    .filter((ev) => ev.startMs >= s && ev.endMs - ev.startMs >= 20 * 60000 && !NOT_CLASS.test(plain(ev.title)))
    .sort((a, b) => a.startMs - b.startMs)[0] || null;
}

// [{ start, end, label }] in ms for that local day, sorted by start
function protectedBlocks(date, events, opts) {
  const day = startOfDay(date), dow = day.getDay(), out = [];
  const add = (start, end, label) => { if (isFinite(start) && isFinite(end) && end > start) out.push({ start, end, label }); };
  const cls = firstClass(day, events);
  add(fajrMs(day, opts && opts.point), cls ? cls.startMs - 3600000 : at(day, NO_CLASS_QURAN_END), "Qur'an");
  if (dow >= 1 && dow <= 4) add(at(day, 9), at(day, 11), "ʿAlim");
  if (dow === 2) add(at(day, 8), at(day, 9), "Qirat");
  if (dow === 5 || dow === 0) add(at(day, 9), at(day, 10), "Qirat");
  if (dow === 5) {
    add(at(day, 13), at(day, 13, 50), "Jumuʿah");
    add(at(day, 19, 30), dayRange(day)[1], "Family time");
  }
  return out.sort((a, b) => a.start - b.start);
}

// The label of the first protected block that [start, end) touches, or null. Accepts Date, ms or ISO.
function overlapsProtected(startMs, endMs, events) {
  const s = toMs(startMs), e0 = toMs(endMs);
  if (!isFinite(s)) return null;
  const e = isFinite(e0) && e0 > s ? e0 : s + 60000;
  for (let day = startOfDay(new Date(s)), n = 0; day.getTime() < e && n < 7; day = addDays(day, 1), n++) {
    const hit = protectedBlocks(day, events).find((b) => b.start < e && b.end > s);
    if (hit) return hit.label;
  }
  return null;
}

// Open stretches of a day, [{ start, end }] in ms, between fromHour and toHour, after now,
// outside protected blocks and timed calendar events, each at least minMinutes long.
function freeSlots(date, events, opts) {
  const o = opts || {};
  const minMs = (o.minMinutes || 30) * 60000;
  const day = startOfDay(date);
  const now = isFinite(o.now) ? o.now : Date.now();
  const lo = Math.max(atHour(day, isFinite(o.fromHour) ? o.fromHour : 8), Math.ceil(now / 900000) * 900000);  // next quarter hour
  const hi = atHour(day, isFinite(o.toHour) ? o.toHour : 22);
  if (hi - lo < minMs) return [];
  const busy = [
    ...protectedBlocks(day, events).map((b) => [b.start, b.end]),
    ...dayEvents(day, events).filter((ev) => ev.endMs > ev.startMs).map((ev) => [ev.startMs, ev.endMs]),
  ].sort((a, b) => a[0] - b[0]);
  const slots = [];
  let cursor = lo;
  for (const [bs, be] of busy) {
    if (cursor >= hi) break;
    if (be <= cursor) continue;
    if (bs > cursor) slots.push({ start: cursor, end: Math.min(bs, hi) });
    cursor = Math.max(cursor, be);
  }
  if (cursor < hi) slots.push({ start: cursor, end: hi });
  return slots.filter((s) => s.end - s.start >= minMs);
}

export { HOME_POINT, fajrMs, firstClass, freeSlots, isSunday, overlapsProtected, protectedBlocks };
