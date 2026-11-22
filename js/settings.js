import * as theme from "../theme.js";
import { MAX_COURSES, addCourse, cleanCourse } from "./courses.js";
import { fb } from "./firebase.js";
import { cleanKit, saveKits } from "./kits.js";
import { locate, place, refreshPlace } from "./location.js";
import { applyLook, look } from "./look.js";
import { showTab } from "./nav.js";
import { state } from "./state.js";
import { addList } from "./tasks.js";
import { toast } from "./toast.js";
import { $, pref, setPref } from "./util.js";

function renderSettings() {
  $("set-theme").value = pref("theme", "auto");
  $("set-art").checked = pref("art", "on") === "on";
  $("set-travel").checked = pref("travel", "on") === "on";
  const t = theme.TIMES[look.time];
  const style = $("set-style");
  if (!style.options.length) {
    const group = (label, items) => { const g = document.createElement("optgroup"); g.label = label; items.forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; g.appendChild(o); }); style.appendChild(g); };
    group("Everyday", [["auto", "Time of day + subject"]]);
    group("One time of day", Object.entries(theme.TIMES).map(([k, t]) => ["time:" + k, t.name]));
    group("Colour editions", Object.entries(theme.EDITIONS).filter(([, e]) => e.group === "Colour").map(([k, e]) => [k, e.name]));
    group("Places", Object.entries(theme.EDITIONS).filter(([, e]) => e.group === "Place").map(([k, e]) => [k, e.name]));
    group("Cities", Object.entries(theme.CITIES).map(([k, c]) => [k, c.name]));
  }
  style.value = pref("style", "auto");
  if (style.value !== pref("style", "auto")) style.value = "auto";
  $("set-theme-row").hidden = style.value !== "auto";
  const fixedLook = theme.EDITIONS[look.city] || (style.value !== "auto" && theme.CITIES[look.city]);
  $("set-now").textContent = fixedLook ? "Right now: " + fixedLook.name + " (held by Style)"
    : look.city ? "Right now: " + theme.CITIES[look.city].name + " colours (travel mode)"
    : "Right now: " + (t ? t.name : "") + " colours" + (look.subject ? " · " + look.subject : " · no subject on");
  const city = $("set-city");
  if (!city.options.length) {
    [["auto", "By location"], ...Object.entries(theme.CITIES).map(([k, c]) => [k, c.name])].forEach(([v, label]) => { const o = document.createElement("option"); o.value = v; o.textContent = label; city.appendChild(o); });
  }
  city.value = theme.CITIES[pref("city", "auto")] ? pref("city", "auto") : "auto";
  $("set-home-note").textContent = place("home") ? "Set (rounded to the nearest town)" : "Not set yet. Travel mode needs it to know when you are away.";
  $("set-home").textContent = place("home") ? "Update to where I am now" : "Set to where I am now";
}

function wireSettings() {
  $("set-theme").addEventListener("change", (e) => { setPref("theme", e.target.value); applyLook(); renderSettings(); });
  $("set-style").addEventListener("change", (e) => { setPref("style", e.target.value); applyLook(); renderSettings(); });
  $("set-art").addEventListener("change", (e) => { setPref("art", e.target.checked ? "on" : "off"); applyLook(); });
  $("set-travel").addEventListener("change", (e) => { setPref("travel", e.target.checked ? "on" : "off"); applyLook(); renderSettings(); });
  $("set-city").addEventListener("change", (e) => { setPref("city", e.target.value); applyLook(); renderSettings(); });
  $("set-home").addEventListener("click", () => {
    const btn = $("set-home");
    btn.disabled = true; btn.textContent = "Finding…";
    locate("home", (ok) => { btn.disabled = false; renderSettings(); toast(ok ? "Home set." : "Couldn't get your location. Check that it's allowed for Homebase."); });
  });
  $("list-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    if (addList($("list-new").value)) $("list-new").value = "";
  });
  $("kit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    const kit = cleanKit({ title: $("kit-title").value, url: $("kit-url").value, course: $("kit-course").value });
    if (!kit) { toast("Give the kit a name and a link that starts with https://"); return; }
    saveKits([...state.kits, kit]);
    $("kit-title").value = ""; $("kit-url").value = "";
  });
  $("course-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!fb || !state.user) return;
    if (addCourse($("course-new").value)) $("course-new").value = "";
  });
  // A link like ...?subjects=BIO%202000,Chem%201130 opens Settings with those names typed in, ready for you to press Add
  try {
    const url = new URL(location.href), given = url.searchParams.get("subjects");
    if (given) {
      $("course-new").value = given.split(",").map(cleanCourse).filter(Boolean).slice(0, MAX_COURSES).join(", ");
      url.searchParams.delete("subjects");
      history.replaceState(null, "", url.pathname + url.search + "#settings");
      showTab();
    }
    // ...?kits=Name~link~Subject|Name~link~Subject lines kits up in Study, where one press adds them
    const kits = url.searchParams.get("kits");
    if (kits) {
      const items = kits.split("|").map((x) => x.split("~")).map(([title, link, course]) => cleanKit({ title, url: link, course })).filter(Boolean);
      if (items.length) sessionStorage.setItem("hb-kit-import", JSON.stringify(items));
      url.searchParams.delete("kits");
      history.replaceState(null, "", url.pathname + url.search + "#study");
      showTab();
    }
  } catch (e) {}
  applyLook();
  refreshPlace();
}


export { renderSettings, wireSettings };
