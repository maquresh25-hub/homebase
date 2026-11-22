// ---------- Screen Time card ----------
import { fb } from "./firebase.js";
import { state } from "./state.js";
import { save } from "./tasks.js";
import { $, addDays, ymd } from "./util.js";

function screenTimeRef(day) { return fb.doc(fb.db, "users", state.user.uid, "screentime", day); }

let unsubscribeScreenTime = null;
function startScreenTime(user) {
  const col = fb.collection(fb.db, "users", user.uid, "screentime");
  unsubscribeScreenTime = fb.onSnapshot(col, (snap) => {
    state.screenTime = {};
    snap.docs.forEach((d) => { state.screenTime[d.id] = d.data(); });
    renderScreenTimeCard();
  }, () => renderScreenTimeCard());
}
function stopScreenTime() { if (unsubscribeScreenTime) { unsubscribeScreenTime(); unsubscribeScreenTime = null; } }

function renderScreenTimeCard() {
  const host = $("screen-time-body");
  if (!host) return;
  host.textContent = "";
  const now = new Date();
  const today = ymd(now);

  // Build last 7 days of data
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = ymd(addDays(now, -i));
    days.push({ date: d, data: state.screenTime[d] || null });
  }

  // Bar chart: 7 days
  const chart = document.createElement("div");
  chart.className = "st-chart";
  const maxMins = Math.max(60, ...days.map((d) => (d.data ? d.data.total || 0 : 0)));
  days.forEach(({ date, data }) => {
    const col = document.createElement("div");
    col.className = "st-col";
    const bar = document.createElement("i");
    bar.className = "st-bar" + (date === today ? " st-today" : "");
    const pct = data && data.total ? Math.max(6, Math.round(100 * data.total / maxMins)) : 0;
    bar.style.setProperty("--h", pct + "%");
    const label = document.createElement("span");
    label.className = "st-day";
    const dow = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "narrow" });
    label.textContent = dow;
    if (data && data.total) {
      const h = Math.floor(data.total / 60), m = data.total % 60;
      bar.setAttribute("title", (h ? h + "h " : "") + m + "m");
    }
    col.append(bar, label);
    chart.appendChild(col);
  });
  host.appendChild(chart);

  // Today's total + top apps (or prompt to log)
  const todayData = state.screenTime[today];
  const summary = document.createElement("div");
  summary.className = "st-summary";
  if (todayData && todayData.total) {
    const h = Math.floor(todayData.total / 60), m = todayData.total % 60;
    const total = document.createElement("p");
    total.className = "st-total";
    total.textContent = "Today: " + (h ? h + "h " : "") + m + "m";
    summary.appendChild(total);
    if (todayData.apps && todayData.apps.length) {
      const apps = document.createElement("ul");
      apps.className = "st-apps";
      todayData.apps.slice(0, 3).forEach((a) => {
        const li = document.createElement("li");
        li.textContent = a;
        apps.appendChild(li);
      });
      summary.appendChild(apps);
    }
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "btn-link st-edit"; edit.textContent = "Edit";
    edit.addEventListener("click", () => openScreenTimeSheet(today, todayData));
    summary.appendChild(edit);
  } else {
    const prompt = document.createElement("p");
    prompt.className = "empty";
    prompt.textContent = "No screen time logged today.";
    summary.appendChild(prompt);
  }
  host.appendChild(summary);

  // Log button
  const log = document.createElement("button");
  log.type = "button"; log.className = "btn-primary st-log";
  log.textContent = todayData && todayData.total ? "Update today" : "Log today";
  log.addEventListener("click", () => openScreenTimeSheet(today, todayData || {}));
  host.appendChild(log);
}

// Sheet for entering / editing a day's screen time
let stSheet = null;
function openScreenTimeSheet(day, existing) {
  // Reuse the stale-sheet backdrop pattern: build a simple inline form
  const sheet = $("st-sheet");
  if (!sheet) {
    // Build once and cache
    const backdrop = document.createElement("div");
    backdrop.id = "st-sheet";
    backdrop.className = "sheet-backdrop";
    backdrop.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="st-sheet-title">
        <h2 id="st-sheet-title" class="sheet-title">Log Screen Time</h2>
        <label class="st-field-label" for="st-total-input">Total screen time (minutes)</label>
        <input id="st-total-input" type="number" min="0" max="1440" inputmode="numeric" class="st-input" placeholder="e.g. 180 for 3 hours">
        <label class="st-field-label" for="st-apps-input">Top apps <span class="st-hint">(one per line, e.g. Instagram: 45m)</span></label>
        <textarea id="st-apps-input" class="st-input st-textarea" rows="4" placeholder="Instagram: 45m&#10;YouTube: 30m&#10;Safari: 20m"></textarea>
        <div class="sheet-actions">
          <button type="button" id="st-save" class="btn-primary">Save</button>
          <button type="button" id="st-cancel" class="btn-link">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    $("st-cancel").addEventListener("click", closeScreenTimeSheet);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeScreenTimeSheet(); });
    $("st-save").addEventListener("click", saveScreenTime);
  }
  stSheet = { day };
  $("st-total-input").value = existing && existing.total ? existing.total : "";
  $("st-apps-input").value = existing && existing.apps ? existing.apps.join("\n") : "";
  $("st-sheet").hidden = false;
  setTimeout(() => $("st-total-input").focus(), 60);
}
function closeScreenTimeSheet() { $("st-sheet").hidden = true; stSheet = null; }
async function saveScreenTime() {
  if (!stSheet || !state.user) return;
  const totalRaw = parseInt($("st-total-input").value, 10);
  const total = isNaN(totalRaw) || totalRaw < 0 ? 0 : Math.min(totalRaw, 1440);
  const apps = $("st-apps-input").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const data = { total, apps, updatedAt: Date.now() };
  state.screenTime[stSheet.day] = data;
  renderScreenTimeCard();
  closeScreenTimeSheet();
  save(fb.setDoc(screenTimeRef(stSheet.day), data));
}

export { renderScreenTimeCard, startScreenTime, stopScreenTime };
