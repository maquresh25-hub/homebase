// Homebase app — v5: shell + sign-in + synced To-Do + Google Calendar timeline + week view + study timer
// v17: weekly goals card, missed-questions bank with spaced redos, Sunday review, study method tags
// Data lives in Firebase Firestore under users/{uid}/tasks/{taskId}.
// Each task is its own document, so a change on one device never overwrites
// other tasks, and nothing is ever hard-deleted (deleted tasks are flagged).
import { wireSignIn } from "./js/auth.js";
import { wireCalendarTab } from "./js/calendar-tab.js";
import { renderCalendar, wireCalendar } from "./js/calendar.js";
import { checkWeekRollover, wireGrowth } from "./js/growth.js";
import { refreshPlace } from "./js/location.js";
import { renderHeader, showTab } from "./js/nav.js";
import { wireSettings } from "./js/settings.js";
import { startData } from "./js/sync.js";
import { checkStale, wireTimer } from "./js/timer.js";
import { renderTimeline, scrollToNow } from "./js/today.js";
import { renderTasks } from "./js/todo.js";


// ================================================================ START
window.addEventListener("hashchange", showTab);
showTab();
renderHeader();
renderTasks();
scrollToNow(renderTimeline());
renderCalendar();
setInterval(() => { renderHeader(); renderCalendar(); checkStale(); checkWeekRollover(); refreshPlace(); }, 60 * 1000);
wireSignIn();
wireCalendar();
wireCalendarTab();
wireTimer();
wireGrowth();
wireSettings();
startData();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline mode unavailable:", e));
}
