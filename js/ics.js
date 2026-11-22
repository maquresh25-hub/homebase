// ================================================================ ADD TO CALENDAR (.ics)
// Builds a one-event calendar file (RFC 5545) and downloads it. The Google Calendar link stays
// read-only: this only hands a file to the device, which offers to add it.
// start/end accept a Date, ms, or an ISO string with an offset ("2026-11-23T18:00:00-05:00").
const CRLF = "\r\n";

function toDate(v) {
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string" && v.trim()) return new Date(v.trim());
  return new Date(NaN);
}
function valid(d) { return d instanceof Date && isFinite(d.getTime()); }
// 2026-11-23T23:00:00.000Z -> 20261123T230000Z
function utc(d) { return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, ""); }
// TEXT values: backslash first, then ; , and line breaks
function esc(v) {
  return String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}
// URL is a URI value, not TEXT: only http(s), already percent-encoded by URL()
function uri(v) {
  try { const u = new URL(String(v || "")); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; } catch (e) { return ""; }
}
// Lines longer than 75 octets continue on the next line after CRLF + one space (counted in UTF-8)
function fold(line) {
  const enc = new TextEncoder();
  let out = "", used = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (used + n > 75) { out += CRLF + " "; used = 1; }
    out += ch;
    used += n;
  }
  return out;
}
// Same title + start gives the same UID, so importing twice updates rather than duplicates
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function buildIcs(evt) {
  const e = evt || {};
  const start = toDate(e.start);
  if (!valid(start)) return null;
  let end = toDate(e.end);
  if (!valid(end) || end <= start) end = new Date(start.getTime() + 3600000);   // no end: an hour
  const title = String(e.title || "").trim() || "Event";
  const uid = String(e.uid || "").trim() || "hb-" + hash(title + "|" + start.getTime()) + "@homebase";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Homebase//Homebase//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:" + esc(uid),
    "DTSTAMP:" + utc(new Date()),
    "DTSTART:" + utc(start),
    "DTEND:" + utc(end),
    "SUMMARY:" + esc(title),
  ];
  if (e.location && String(e.location).trim()) lines.push("LOCATION:" + esc(String(e.location).trim()));
  const url = uri(e.url);
  if (url) lines.push("URL:" + url);
  if (e.description && String(e.description).trim()) lines.push("DESCRIPTION:" + esc(String(e.description).trim()));
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join(CRLF) + CRLF;
}

function downloadIcs(evt, filename) {
  const text = buildIcs(evt);
  if (!text) return false;
  const base = String(filename || (evt && evt.title) || "event").replace(/\.ics$/i, "")
    .replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60);
  try {
    const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = (base || "event") + ".ics";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return true;
  } catch (e) {
    console.warn("Couldn't make the calendar file:", e);
    return false;
  }
}

export { buildIcs, downloadIcs };
