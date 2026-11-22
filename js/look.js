// ================================================================ SETTINGS: colours
// The choice is saved on this device (localStorage), so the Mac and the iPhone can differ.
import * as theme from "../theme.js";
import { todaysEvents } from "./calendar.js";
import { courseColour } from "./courses.js";
import { isBlock } from "./draw.js";
import { currentCity } from "./location.js";
import { renderSettings } from "./settings.js";
import { state } from "./state.js";
import { timer } from "./timer.js";
import { $, pref } from "./util.js";

const look = { subject: "", time: "", city: null };

// The subject being studied right now: a running timer wins, then the calendar block happening now.
function currentSubject() {
  const texts = [], now = Date.now();
  if (timer.running) texts.push(timer.running.course, timer.running.label);
  const block = todaysEvents().filter(isBlock).filter((e) => e.startMs <= now && e.endMs > now).pop();
  if (block) texts.push(block.title);
  for (const text of texts) {
    const name = text && theme.matchSubject(text, state.courses);
    if (name) return name;
  }
  return "";
}

// ---- the drawing behind the page: a city skyline when travelling, else fine line art for the subject
let backdropKey = null;
async function renderBackdrop(city, subject) {
  const host = $("backdrop");
  const key = city ? "city:" + city : pref("art", "on") === "on" ? "art:" + theme.artKey(subject) : "";
  if (!host || key === backdropKey) return;
  backdropKey = key;
  if (!key) { host.textContent = ""; return; }
  try {
    let svg;
    if (city) {
      const sky = (await import("../skylines.js")).SKYLINES[city];
      const paint = (s) => s.replace(/url\(#WIN\)/g, "url(#bd-win)").replace(/fill="GROUNDC"/g, 'style="fill: var(--bg)"');
      svg = '<svg viewBox="0 0 1200 900" preserveAspectRatio="xMidYMax slice" fill="currentColor" style="color: var(--deep)"><defs>' +
        '<linearGradient id="bd-fade" gradientUnits="userSpaceOnUse" x1="0" y1="900" x2="0" y2="0"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#9a9a9a"/><stop offset="1" stop-color="#3a3a3a"/></linearGradient>' +
        '<mask id="bd-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="900"><rect width="1200" height="900" fill="url(#bd-fade)"/></mask>' +
        '<pattern id="bd-win" width="13" height="17" patternUnits="userSpaceOnUse"><rect x="3" y="4" width="5" height="8" style="fill: var(--bg)" fill-opacity=".55"/></pattern></defs>' +
        '<g mask="url(#bd-mask)"><g opacity=".04">' + paint(sky.back) + '</g><g opacity=".085">' + paint(sky.front) + '<rect y="895" width="1200" height="5"/></g></g></svg>';
    } else {
      const art = (await import("../art.js")).ART[key.slice(4)];
      svg = '<svg viewBox="0 0 1200 900" preserveAspectRatio="xMaxYMax slice" style="color: var(--text)"><defs>' +
        '<radialGradient id="bd-fade" gradientUnits="userSpaceOnUse" cx="1100" cy="860" r="900"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#6a6a6a"/><stop offset="1" stop-color="#000"/></radialGradient>' +
        '<mask id="bd-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1200" height="900"><rect width="1200" height="900" fill="url(#bd-fade)"/></mask></defs>' +
        '<g mask="url(#bd-mask)" fill="none" stroke="currentColor" stroke-width=".75" stroke-linecap="round" stroke-linejoin="round" opacity=".12">' + art + "</g></svg>";
    }
    if (backdropKey === key) host.innerHTML = svg;
  } catch (e) { console.warn("Couldn't load the background art:", e); backdropKey = null; }
}

function applyLook() {
  const choice = pref("theme", "auto"), style = pref("style", "auto");
  const held = style.startsWith("time:") && theme.TIMES[style.slice(5)] ? style.slice(5) : "";   // one time-of-day look, held all day
  const time = held || (choice === "light" ? "afternoon" : choice === "dark" ? "night" : theme.timeOfDay(new Date()));
  const fixed = theme.EDITIONS[style] || theme.CITIES[style] ? style : null;                    // one palette, held all day
  const subject = currentSubject(), city = fixed || currentCity();
  theme.apply(time, subject ? courseColour(subject) : null, city);
  renderBackdrop(theme.CITIES[city] ? city : null, subject);
  const changed = subject !== look.subject || time !== look.time || city !== look.city;
  look.subject = subject; look.time = time; look.city = city;
  if (changed && $("view-settings") && !$("view-settings").hidden) renderSettings();
}


export { applyLook, look };
