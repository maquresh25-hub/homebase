// ---- travel mode
import * as theme from "../theme.js";
import { applyLook } from "./look.js";
import { pref, setPref } from "./util.js";

function place(k) { try { const p = JSON.parse(pref(k, "null")); return p && isFinite(p.lat) && isFinite(p.lon) ? p : null; } catch (e) { return null; } }
function currentCity() {
  if (pref("travel", "on") !== "on") return null;
  const pick = pref("city", "auto");
  if (theme.CITIES[pick]) return pick;
  return pick === "auto" ? theme.cityNear(place("pos"), place("home")) : null;
}
function locate(saveAs, then) {
  if (!navigator.geolocation) { if (then) then(false); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    // one decimal place is about 10 km: enough to tell cities apart, not an address
    const at = { lat: Math.round(pos.coords.latitude * 10) / 10, lon: Math.round(pos.coords.longitude * 10) / 10, at: Date.now() };
    setPref("pos", JSON.stringify(at));
    if (saveAs === "home") setPref("home", JSON.stringify(at));
    applyLook();
    if (then) then(true);
  }, () => { if (then) then(false); }, { timeout: 15000, maximumAge: 600000 });
}
// Quietly re-check where we are, at most hourly, and only once location has already been allowed
function refreshPlace() {
  if (pref("travel", "on") !== "on" || pref("city", "auto") !== "auto" || !place("home")) return;
  const pos = place("pos");
  if (pos && Date.now() - (pos.at || 0) < 3600000) return;
  if (!navigator.permissions || !navigator.permissions.query) return;
  navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") locate(null); }).catch(() => {});
}


export { currentCity, locate, place, refreshPlace };
