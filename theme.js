// Homebase theme engine (v20).
// Time of day sets the page; the subject being studied sets the deep colour and the accent.
// Colours come from the Homebase Color Design System (six time-of-day themes, six subject colours).

// page ground, card, text, secondary text, line, bottom tint, panel
export const TIMES = {
  "dawn":        { name: "Dawn",        bg: "#FDF2F8", card: "#FFFFFF", text: "#4A1458", muted: "#7B3FA0", line: "#E9C8F5", end: "#F5E6FF", mid: "#C084FC" },
  "morning":     { name: "Morning",     bg: "#F0F9FF", card: "#FFFFFF", text: "#0C4A6E", muted: "#0369A1", line: "#BAE6FD", end: "#DBEAFE", mid: "#38BDF8" },
  "afternoon":   { name: "Afternoon",   bg: "#F8FAFC", card: "#FFFFFF", text: "#0F172A", muted: "#334155", line: "#CBD5E1", end: "#EFF6FF", mid: "#94A3B8" },
  "golden-hour": { name: "Golden hour", bg: "#FFFBEB", card: "#FFFFFF", text: "#451A03", muted: "#78350F", line: "#FDE68A", end: "#FFF7CD", mid: "#FBBF24" },
  "dusk":        { name: "Dusk",        bg: "#1A0E2E", card: "#2D1B4E", text: "#F5F3FF", muted: "#DDD6FE", line: "#4C3580", end: "#2D1B4E", mid: "#6D4CA0", raised: "#3D2666", dark: true },
  "night":       { name: "Night",       bg: "#0D0F1A", card: "#161928", text: "#E2E8F0", muted: "#94A3B8", line: "#334155", end: "#161928", mid: "#334155", raised: "#1E2235", dark: true },
};

export function timeOfDay(date) {
  const h = date.getHours();
  if (h >= 5 && h < 7) return "dawn";
  if (h >= 7 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 19) return "golden-hour";
  if (h >= 19 && h < 21) return "dusk";
  return "night";
}

// ---- colour maths
const parts = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const rgb = (hex) => parts(hex).join(",");
export function mix(a, b, share) {   // `share` of a, the rest b
  const A = parts(a), B = parts(b);
  return "#" + A.map((x, i) => Math.round(x * share + B[i] * (1 - share)).toString(16).padStart(2, "0")).join("").toUpperCase();
}
export function luminance(hex) {
  const [r, g, b] = parts(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const readable = (bg, a, b) => (contrast(bg, a) >= contrast(bg, b) ? a : b);
export const isColour = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

// ---- subjects
const KNOWN = [["bio", "#16A34A"], ["chem", "#0891B2"], ["orgo", "#0891B2"], ["hindu", "#EA580C"], ["metap", "#7C3AED"], ["philo", "#7C3AED"],
  ["alim", "#15803D"], ["qirat", "#15803D"], ["quran", "#15803D"], ["hifz", "#15803D"], ["pharm", "#1D4ED8"]];
const SPARE = ["#BE185D", "#B45309", "#0F766E", "#4338CA", "#9D174D", "#4D7C0F"];
const GENERIC = new Set(["class", "intro", "introduction", "lab", "lecture", "study", "exam", "quiz", "review", "the", "and", "for", "with",
  "session", "recitation", "block", "course", "prep", "practice", "aspects"]);
const plain = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯʻ-ʿ'’`]/g, "").toLowerCase();
function stems(name) {
  return plain(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/\d/.test(w) && !GENERIC.has(w)).map((w) => w.slice(0, 5));
}
// Which of the user's subjects a calendar title or timer label belongs to. "Chem 1130" matches "Chemistry Recitation".
export function matchSubject(text, subjects) {
  const t = plain(text);
  let best = null, bestLen = 0;
  (subjects || []).forEach((name) => {
    stems(name).forEach((stem) => {
      if (stem.length > bestLen && new RegExp("(^|[^a-z0-9])" + stem).test(t)) { best = name; bestLen = stem.length; }
    });
  });
  return best;
}
export function defaultColour(name, index) {
  const s = stems(name);
  const hit = KNOWN.find(([stem]) => s.some((w) => w.startsWith(stem) || stem.startsWith(w)));
  return hit ? hit[1] : SPARE[Math.max(0, index) % SPARE.length];
}

// ---- the palette for this moment
export function palette(timeId, subjectColour) {
  const t = TIMES[timeId] || TIMES.afternoon, dark = !!t.dark;
  let deep, mid, third, heroText, heroAccent, accent;
  if (isColour(subjectColour)) {
    const c = subjectColour.toUpperCase();
    deep = mix(c, "#000000", 0.55); mid = c;
    for (const share of [0.45, 0.35, 0.25, 0.15]) {      // pale subject colours need a darker top to carry white text
      if (contrast("#FFFFFF", deep) >= 7) break;
      deep = mix(c, "#000000", share);
    }
    third = dark ? t.end : mix(c, "#FFFFFF", 0.16);
    heroText = "#FFFFFF"; heroAccent = mix(c, "#FFFFFF", 0.18);
    accent = c;
    for (const share of [0.85, 0.7, 0.55, 0.4]) {       // nudge it until it reads on the page
      if (contrast(accent, t.bg) >= 3.2) break;
      accent = mix(c, dark ? "#FFFFFF" : "#000000", share);
    }
  } else {
    deep = dark ? t.raised : t.text; mid = t.mid; third = t.end;
    heroText = dark ? t.text : t.bg; heroAccent = "#E8CC8A";
    accent = dark ? "#D9B866" : "#8A6A2F";
  }
  let heroMuted = mix(heroText, deep, 0.74);
  if (contrast(heroMuted, deep) < 4.5) heroMuted = mix(heroText, deep, 0.88);
  let onAccent = readable(heroAccent, deep, heroText);
  if (contrast(onAccent, heroAccent) < 4.5) onAccent = readable(heroAccent, "#111111", "#FFFFFF");
  return {
    dark, deep,
    vars: {
      "--bg": t.bg, "--card": t.card, "--text": t.text, "--muted": t.muted, "--line": t.line, "--gold": accent,
      "--deep": deep, "--mid": mid, "--third": third,
      "--hero-text": heroText, "--hero-muted": heroMuted, "--hero-accent": heroAccent,
      "--on-accent": onAccent, "--on-gold": readable(accent, t.bg, t.text),
      "--hero-line": "rgba(" + rgb(heroText) + ",0.2)",
    },
  };
}

let applied = "";
export function apply(timeId, subjectColour) {
  const key = timeId + "|" + (subjectColour || "");
  if (key === applied) return;
  applied = key;
  const p = palette(timeId, subjectColour), root = document.documentElement;
  Object.entries(p.vars).forEach(([k, v]) => root.style.setProperty(k, v));
  root.dataset.theme = p.dark ? "dark" : "light";
  root.dataset.time = timeId;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = p.deep; });
}
