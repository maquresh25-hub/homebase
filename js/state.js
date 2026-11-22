
const DEFAULT_START = 8;  // timeline normally runs 8 AM
const DEFAULT_END = 22;   // to 10 PM, and stretches to fit earlier or later events
const EVENTS_CACHE = "hb-events-v1";      // this device's copy of the last calendar fetch
const REFRESH_MS = 10 * 60 * 1000;        // refetch the calendar every 10 minutes
const TABS = ["today", "calendar", "todo", "discover", "study", "journal", "settings"];
const MAX_TITLE = 200;
const TODAY_LIMIT = 6;  // tasks shown on the Today card


// ---------------------------------------------------------------- state
const state = {
  status: "loading",  // loading | ready | error
  user: null,
  tasks: [],          // non-deleted tasks
  showCompleted: false,
  calUrl: null,       // private calendar link (stored in Firestore, never in the code)
  calStatus: "none",  // none | loading | ready | error
  events: [],         // events from Google Calendar
  eventsAt: null,     // when they were fetched
  doneEvents: new Set(), // calendar deadlines marked done (synced in Firestore)
  doneList: [],          // the same deadlines with titles, for the "Done deadlines" list
  showDoneDeadlines: false,
  kitLinks: {},          // exam name -> link to its exam kit (synced in settings/kits)
  courses: [],           // subjects for tagging tasks (synced in settings/courses)
  courseColors: {},      // subject name -> its colour
  lists: [],             // to-do lists (synced in settings/lists)
  kits: [],              // exam kits shown in Study (synced in settings/kits)
  range: null,        // [startMs, endMs] the main copy covers
  screenTime: {},     // { "YYYY-MM-DD": { total: minutes, apps: ["App: Xm", ...] } }
};

export { DEFAULT_END, DEFAULT_START, EVENTS_CACHE, MAX_TITLE, REFRESH_MS, TABS, TODAY_LIMIT, state };
