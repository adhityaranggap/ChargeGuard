// ChargeGuard desktop widget for Übersicht 1.6.
// Reads ~/.chargeguard/status.json (type Status in src/types.ts).
// Sends every change through the `cg` CLI. The widget has no text inputs.
import { run, css, React } from "uebersicht";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CG = '"$HOME/.chargeguard/bin/cg"';
const SETUP_CMD = "sudo bash ~/.chargeguard/app/scripts/install-root.sh";
const KICK_CMD = "launchctl kickstart -k gui/$(id -u)/com.chargeguard.daemon";

const STALE_MS = 90000; // status file older than this = daemon stopped
const PLUG_MS = 20000; // plug-in banner time
const UNPLUG_MS = 10000; // unplug banner time
const PEND_MS = 10000; // longest pending time for a control
const CONFIRM_MS = 5000; // reset time for the 2-step confirm
const TOAST_MS = 5000;

export const command =
  "cat \"$HOME/.chargeguard/status.json\" 2>/dev/null || echo '{}'";
export const refreshFrequency = 2000;

export const className = css`
  position: absolute;
  left: 16px;
  bottom: 16px;
  z-index: 10;
`;

// The preview page can set window.__CG_NOW__ (ms number or ISO text).
const nowMs = () => {
  if (typeof window !== "undefined" && window.__CG_NOW__ != null) {
    const v = window.__CG_NOW__;
    return typeof v === "string" ? Date.parse(v) : Number(v);
  }
  return Date.now();
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const pad = (n) => (n < 10 ? "0" : "") + n;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toMin = (t) => {
  const p = String(t || "0:0").split(":");
  return Number(p[0]) * 60 + Number(p[1]);
};
const fromMin = (n) => pad(Math.floor(n / 60)) + ":" + pad(n % 60);
const get = (o, path) =>
  path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
const same = (a, b) =>
  (a == null && b == null) || JSON.stringify(a) === JSON.stringify(b);

// Day order shown in the UI: Monday first. Values follow Date.getDay().
const DAYS = [
  { n: 1, s: "M", l: "Monday", a: "Mon" },
  { n: 2, s: "T", l: "Tuesday", a: "Tue" },
  { n: 3, s: "W", l: "Wednesday", a: "Wed" },
  { n: 4, s: "T", l: "Thursday", a: "Thu" },
  { n: 5, s: "F", l: "Friday", a: "Fri" },
  { n: 6, s: "S", l: "Saturday", a: "Sat" },
  { n: 0, s: "S", l: "Sunday", a: "Sun" },
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Clock text "HH:MM" in the daemon local time.
function hhmm(iso) {
  if (!iso) return "";
  if (!/Z$/.test(iso)) {
    const m = /T(\d\d:\d\d)/.exec(iso);
    if (m) return m[1];
  }
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function fmtDate(iso) {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(iso || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "Never";
}

// "about 42 min", "about 1 h 5 min", "about 6 h".
function fmtSpan(min) {
  const m = Math.round(min);
  if (m < 60) return `about ${m} min`;
  if (m < 180) return `about ${Math.floor(m / 60)} h ${m % 60} min`;
  return `about ${Math.round(m / 60)} h`;
}

function shortMac(mac) {
  const p = String(mac).split(":");
  return p.length === 6 ? `${p[0]}:${p[1]}:…:${p[5]}` : mac;
}

function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} min`;
  return `${Math.round(m / 60)} h`;
}

const placeLimit = (st) => {
  const p = st.config.places[st.decision.place];
  return p && p.limit != null ? p.limit : st.config.limit;
};

// ---------------------------------------------------------------------------
// Pending checks. An `expect` object describes what status must show.
// ---------------------------------------------------------------------------

function met(status, e) {
  if (!status || !e) return false;
  const v = get(status, e.path);
  switch (e.op) {
    case "eq":
      return same(v, e.val);
    case "neq":
      return !same(v, e.val);
    case "gt":
      return typeof v === "number" && v > e.val;
    case "has":
      return Array.isArray(v) && v.indexOf(e.val) >= 0;
    case "notHasId":
      return !(Array.isArray(v) && v.some((r) => r.id === e.val));
    case "match":
      return !!v && Object.keys(e.val).every((k) => same(v[k], e.val[k]));
    default:
      return false;
  }
}

function prunePending(pending, status, now) {
  const out = {};
  Object.keys(pending).forEach((k) => {
    const p = pending[k];
    if (now - p.at > PEND_MS) return;
    if (status && met(status, p.expect)) return;
    out[k] = p;
  });
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const initialState = {
  status: null,
  parsedAt: 0,
  drawer: typeof window !== "undefined" && !!window.__CG_DRAWER__,
  pending: {},
  confirm: null,
  toast: null,
  draft: { days: [1, 2, 3, 4, 5], time: 390, action: "topup" },
};

export const updateState = (event, prev) => {
  const now = nowMs();
  switch (event.type) {
    case "UB/COMMAND_RAN": {
      const text = String(event.output || "").trim();
      if (!text) return prev;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return prev;
      }
      const ok = parsed && parsed.snapshot && parsed.decision && parsed.config;
      const status = ok ? parsed : null;
      return {
        ...prev,
        status,
        parsedAt: now,
        pending: prunePending(prev.pending, status, now),
      };
    }
    case "CG_DRAWER":
      return { ...prev, drawer: !prev.drawer };
    case "CG_PENDING": {
      const pending = { ...prev.pending };
      pending[event.key] = { expect: event.expect, shown: event.shown, at: event.at };
      return { ...prev, pending };
    }
    case "CG_FAIL": {
      const pending = { ...prev.pending };
      delete pending[event.key];
      return { ...prev, pending, toast: { text: event.text, at: now } };
    }
    case "CG_CONFIRM":
      return { ...prev, confirm: { id: event.id, at: event.at } };
    case "CG_CONFIRM_CLEAR":
      return { ...prev, confirm: null };
    case "CG_TOAST":
      return { ...prev, toast: { text: event.text, at: now } };
    case "CG_DRAFT":
      return { ...prev, draft: { ...prev.draft, ...event.patch } };
    case "CG_TICK": {
      const confirm = prev.confirm && now - prev.confirm.at < CONFIRM_MS ? prev.confirm : null;
      const toast = prev.toast && now - prev.toast.at < TOAST_MS ? prev.toast : null;
      return { ...prev, confirm, toast, pending: prunePending(prev.pending, prev.status, now) };
    }
    default:
      return prev;
  }
};

// ---------------------------------------------------------------------------
// Actions. Each action runs one cg command and sets a pending mark.
// ---------------------------------------------------------------------------

const timers = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function act(dispatch, key, cmd, expect, shown, delay) {
  dispatch({ type: "CG_PENDING", key, expect, shown, at: nowMs() });
  clearTimeout(timers[key]);
  timers[key] = setTimeout(() => {
    run(cmd)
      .then(() => sleep(1200))
      .then(() => run(command))
      .then((out) => dispatch({ type: "UB/COMMAND_RAN", output: out }))
      .catch(() => dispatch({ type: "CG_FAIL", key, text: "The command failed. Try again." }));
  }, delay || 0);
  setTimeout(() => dispatch({ type: "CG_TICK" }), PEND_MS + 300);
}

function makeCx(state, dispatch, now) {
  return {
    state,
    dispatch,
    now,
    st: state.status,
    pend: (k) => state.pending[k] || null,
    val: (k, actual) => (state.pending[k] ? state.pending[k].shown : actual),
    act: (key, cmd, expect, shown, delay) => act(dispatch, key, cmd, expect, shown, delay),
    confirming: (id) => !!state.confirm && state.confirm.id === id && now - state.confirm.at < CONFIRM_MS,
    // First tap arms the confirm. Second tap inside 5 s runs `go`.
    confirmTap: (id, go) => {
      if (state.confirm && state.confirm.id === id && nowMs() - state.confirm.at < CONFIRM_MS) {
        dispatch({ type: "CG_CONFIRM_CLEAR" });
        go();
      } else {
        dispatch({ type: "CG_CONFIRM", id, at: nowMs() });
        setTimeout(() => dispatch({ type: "CG_TICK" }), CONFIRM_MS + 200);
      }
    },
    toast: (text) => {
      dispatch({ type: "CG_TOAST", text });
      setTimeout(() => dispatch({ type: "CG_TICK" }), TOAST_MS + 200);
    },
  };
}

// Config value through `cg set`.
function cfgSet(cx, path, val, delay) {
  cx.act(
    "set:" + path,
    `${CG} set ${path} ${val}`,
    { path: "config." + path, op: "eq", val },
    val,
    delay
  );
}

function limitSet(cx, n) {
  cx.act("limit", `${CG} limit ${n}`, { path: "config.limit", op: "eq", val: n }, n, 450);
}

// Office hours: all fields go in one command.
function officeSet(cx, next) {
  const cmd = `${CG} office-hours set --start ${next.start} --end ${next.end} --lead ${next.leadMin} --days ${next.days.join(",")}`;
  cx.act("oh", cmd, { path: "config.officeHours", op: "match", val: next }, next, 500);
}

function officeToggle(cx, on) {
  cx.act(
    "oh-on",
    `${CG} office-hours ${on ? "on" : "off"}`,
    { path: "config.officeHours.enabled", op: "eq", val: on },
    on
  );
}

// ---------------------------------------------------------------------------
// Icons. Drawn here. 24 x 24 grid, stroke style.
// ---------------------------------------------------------------------------

const ICONS = {
  battery: (
    <g>
      <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
      <path d="M22 10.5v3" />
    </g>
  ),
  bolt: <path d="M13 2.5 5.5 13.5H11l-1 8 8-11.5h-5.5z" />,
  house: (
    <g>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v10h13V10" />
      <path d="M10 20v-5h4v5" />
    </g>
  ),
  building: (
    <g>
      <rect x="5" y="3" width="14" height="18" rx="1.5" />
      <path d="M9 7.5h2M13 7.5h2M9 11.5h2M13 11.5h2" />
      <path d="M10 21v-4h4v4" />
    </g>
  ),
  globe: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18" />
    </g>
  ),
  plane: (
    <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z" />
  ),
  thermo: (
    <g>
      <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
      <path d="M12 10v6" />
    </g>
  ),
  gear: (
    <g>
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </g>
  ),
  leaf: (
    <g>
      <path d="M5 19C5 10 10 5 20 5c0 10-5 15-13 15" />
      <path d="M5 19c3-4 6-7 10-9" />
    </g>
  ),
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  down: <path d="M12 4v14M6 13l6 6 6-6" />,
  pause: (
    <g>
      <path d="M8.5 6v12M15.5 6v12" />
    </g>
  ),
  play: <path d="M8 5.5v13l11-6.5z" />,
  warn: (
    <g>
      <path d="M12 3.5 22 20.5H2z" />
      <path d="M12 10v4.5M12 17.5v.5" />
    </g>
  ),
  plug: (
    <g>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </g>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  clock: (
    <g>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </g>
  ),
};

const FILLED = { bolt: 1, play: 1, plane: 1 };

const Icon = ({ n, s = 16 }) => (
  <svg
    width={s}
    height={s}
    viewBox="0 0 24 24"
    fill={FILLED[n] ? "currentColor" : "none"}
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {ICONS[n]}
  </svg>
);

// ---------------------------------------------------------------------------
// Styles. One global style element. Keyframes need global names.
// ---------------------------------------------------------------------------

const DARK_VARS = `
  --bg: rgba(22,22,24,0.78); --bd: rgba(255,255,255,0.08);
  --fg: #f5f5f7; --fg2: rgba(235,235,245,0.74); --fg3: rgba(235,235,245,0.62);
  --btn: rgba(255,255,255,0.09); --btnh: rgba(255,255,255,0.15);
  --line: rgba(255,255,255,0.10); --track: rgba(255,255,255,0.12);
  --segon: rgba(255,255,255,0.18); --code: rgba(255,255,255,0.08);
  --hatch: rgba(255,255,255,0.34); --ring: #6cb0ff; --ctl: #5a5a60;
  --shadow: 0 12px 32px rgba(0,0,0,0.35);
`;
const LIGHT_VARS = `
  --bg: rgba(248,248,250,0.86); --bd: rgba(0,0,0,0.08);
  --fg: #1d1d1f; --fg2: rgba(34,34,40,0.80); --fg3: rgba(34,34,40,0.68);
  --btn: rgba(0,0,0,0.06); --btnh: rgba(0,0,0,0.11);
  --line: rgba(0,0,0,0.10); --track: rgba(0,0,0,0.12);
  --segon: #ffffff; --code: rgba(0,0,0,0.07);
  --hatch: rgba(0,0,0,0.30); --ring: #0a60d0; --ctl: #9a9aa0;
  --shadow: 0 12px 32px rgba(0,0,0,0.18);
`;

// Widget themes. "tone" picks the dark or light base colors. "vars" changes the base.
// Auto follows the macOS appearance.
const THEMES = [
  { v: "auto", t: "Auto", tone: "auto", sw: "linear-gradient(135deg,#1c1c1e 50%,#f2f2f5 50%)" },
  { v: "dark", t: "Dark", tone: "dark", sw: "#1c1c1e" },
  { v: "light", t: "Light", tone: "light", sw: "#f2f2f5" },
  { v: "glass", t: "Glass", tone: "dark", sw: "rgba(120,120,130,0.45)", vars: `
    --bg: rgba(30,30,34,0.42); --bd: rgba(255,255,255,0.22); --btn: rgba(255,255,255,0.14);
    --btnh: rgba(255,255,255,0.22); --segon: rgba(255,255,255,0.26);` },
  { v: "graphite", t: "Graphite", tone: "dark", sw: "#2c2c2e", vars: `
    --bg: rgba(44,44,46,0.97); --bd: rgba(255,255,255,0.10); --shadow: 0 12px 32px rgba(0,0,0,0.5);` },
  { v: "midnight", t: "Midnight", tone: "dark", sw: "#14203f", vars: `
    --bg: rgba(14,22,48,0.88); --bd: rgba(120,160,255,0.20);
    --fg: #eef3ff; --fg2: rgba(225,233,255,0.78); --fg3: rgba(225,233,255,0.66);
    --btn: rgba(120,160,255,0.14); --btnh: rgba(120,160,255,0.22); --segon: rgba(120,160,255,0.30);
    --line: rgba(120,160,255,0.16); --track: rgba(120,160,255,0.20); --ring: #8fb8ff;` },
  { v: "sand", t: "Sand", tone: "light", sw: "#efe3cc", vars: `
    --bg: rgba(250,243,230,0.93); --bd: rgba(120,80,30,0.16);
    --fg: #2b2118; --fg2: rgba(43,33,24,0.80); --fg3: rgba(43,33,24,0.68);
    --btn: rgba(120,80,30,0.08); --btnh: rgba(120,80,30,0.14); --segon: #fffaf0;
    --line: rgba(120,80,30,0.14); --track: rgba(120,80,30,0.14); --ring: #9a4f1f; --ctl: #b9a58c;` },
  { v: "contrast", t: "Contrast", tone: "dark", sw: "#000", vars: `
    --bg: rgba(0,0,0,0.96); --bd: rgba(255,255,255,0.55);
    --fg: #ffffff; --fg2: rgba(255,255,255,0.92); --fg3: rgba(255,255,255,0.86);
    --btn: rgba(255,255,255,0.16); --btnh: rgba(255,255,255,0.26); --segon: rgba(255,255,255,0.40);
    --line: rgba(255,255,255,0.35); --track: rgba(255,255,255,0.30); --ring: #ffd60a;` },
];

// Widget scale in percent. The widget uses it as CSS zoom.
const SCALE_MIN = 70;
const SCALE_MAX = 150;

const WAVE_D ="M0 8q10 -6 20 0" + "t20 0".repeat(39) + "V16H0Z";

const STYLES = `
.cg-wrap{ ${DARK_VARS}
  width:360px; display:flex;
  max-height:calc(var(--cg-vh, 100vh) * var(--cg-ph, 1) / var(--cg-z, 1) - 32px); flex-direction:column; justify-content:flex-end; gap:8px;
  font-family:-apple-system,"SF Pro Text",system-ui,sans-serif; font-size:13px; line-height:1.35; color:var(--fg);
  -webkit-font-smoothing:antialiased; user-select:none; -webkit-user-select:none; box-sizing:border-box; }
.cg-wrap[data-tone=light]{ ${LIGHT_VARS} }
${THEMES.filter((t) => t.vars).map((t) => `.cg-wrap[data-theme=${t.v}]{ ${t.vars} }`).join("\n")}
.cg-wrap *{ box-sizing:border-box; }
.cg-card,.cg-drawer{ --ct:var(--c); }
.cg-wrap[data-tone=light] .cg-card,.cg-wrap[data-tone=light] .cg-drawer{ --ct:var(--cl); }
.cg-wrap button{ font:inherit; color:inherit; background:none; border:0; padding:0; margin:0; cursor:pointer; }
.cg-wrap button:focus-visible{ outline:2px solid var(--ring); outline-offset:2px; }
.cg-wrap p,.cg-wrap h3{ margin:0; }
.cg-num{ font-family:"SF Pro Rounded",ui-rounded,-apple-system,"SF Pro Text",sans-serif; font-variant-numeric:tabular-nums; }

.cg-card{ flex:none; position:relative; background:var(--bg); -webkit-backdrop-filter:blur(24px) saturate(140%); backdrop-filter:blur(24px) saturate(140%);
  border:1px solid var(--bd); border-radius:22px; padding:16px; box-shadow:var(--shadow);
  transform-origin:bottom left; transition:transform .3s ease-out; animation:cg-fade .3s ease-out; }
.cg-card.cg-plug{ transform:scale(1.022); }
.cg-wrap[data-corner^=top]{ flex-direction:column-reverse; }
.cg-wrap[data-corner=top-left] .cg-card{ transform-origin:top left; }
.cg-wrap[data-corner=top-right] .cg-card{ transform-origin:top right; }
.cg-wrap[data-corner=bottom-right] .cg-card{ transform-origin:bottom right; }
.cg-body{ transition:opacity .3s ease-out; }
.cg-body[data-dim=true]{ opacity:.5; }

.cg-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px; }
.cg-place{ display:inline-flex; align-items:center; gap:8px; min-width:0; font-size:13px; font-weight:600; }
.cg-place svg{ color:var(--fg2); flex:none; }
.cg-place small{ font-size:11px; font-weight:400; color:var(--fg3); }
.cg-ib{ width:28px; height:28px; border-radius:8px; background:var(--btn); display:grid; place-items:center; flex:none; transition:background .2s ease-out; }
.cg-ib:hover{ background:var(--btnh); }
.cg-ib svg{ transition:transform .3s ease-out; }
.cg-ib[aria-expanded=true] svg{ transform:rotate(60deg); }

.cg-alert{ display:flex; gap:8px; padding:12px; margin-bottom:12px; border-radius:12px; background:var(--cbg); animation:cg-rise .3s ease-out; }
.cg-alert > svg{ flex:none; margin-top:1px; color:var(--ct); }
.cg-alert b{ display:block; font-size:13px; }
.cg-alert span{ font-size:12px; color:var(--fg2); }
.cg-alert .cg-acts{ margin-top:8px; }
.cg-banner{ display:flex; gap:8px; align-items:flex-start; padding:8px 12px; margin-bottom:12px; border-radius:12px; background:var(--cbg);
  font-size:13px; font-weight:500; animation:cg-rise .3s ease-out; transition:opacity .4s ease-out; }
.cg-banner svg{ flex:none; margin-top:1px; color:var(--ct); }
.cg-banner[data-out=true]{ opacity:0; }
.cg-code{ font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:11px; background:var(--code); padding:8px; border-radius:8px; margin-top:8px;
  word-break:break-all; user-select:text; -webkit-user-select:text; color:var(--fg); display:block; }

.cg-main{ display:flex; align-items:center; gap:12px; }
.cg-bi{ position:relative; width:44px; height:44px; display:grid; place-items:center; flex:none; color:var(--ct); }
.cg-bi .cg-ringsvg{ position:absolute; inset:0; transform:rotate(-90deg); }
.cg-bi .cg-ringsvg circle{ fill:none; stroke:var(--c); stroke-width:2.5; stroke-linecap:round; stroke-dasharray:126; stroke-dashoffset:0; animation:cg-ring .6s ease-out; }
.cg-pct{ font-size:44px; font-weight:600; line-height:1; letter-spacing:-0.02em; white-space:nowrap; }
.cg-pct span{ font-size:22px; font-weight:500; color:var(--fg2); margin-left:2px; letter-spacing:0; }
.cg-mb{ flex:1; min-width:0; }
.cg-mode{ display:flex; gap:6px; align-items:flex-start; font-size:13px; font-weight:600; color:var(--ct); }
.cg-mode svg{ flex:none; margin-top:1px; }
.cg-sub{ font-size:11px; color:var(--fg3); margin-top:2px; }
.cg-apply{ display:inline-flex; align-items:center; gap:6px; margin-top:4px; padding:2px 8px; border-radius:999px; background:var(--btn); font-size:11px; font-weight:600; color:var(--fg2); }
.cg-spin{ width:10px; height:10px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:cg-spin .8s linear infinite; display:inline-block; }

.cg-barw{ position:relative; padding:3px 0; margin-top:16px; }
.cg-bar{ position:relative; height:16px; border-radius:8px; background:var(--track); overflow:hidden; }
.cg-fill{ position:absolute; left:0; top:0; bottom:0; min-width:16px; border-radius:8px; background:var(--c); overflow:hidden; transition:width .4s ease-out, background-color .3s ease-out; }
.cg-wrap[data-tone=light] .cg-fill{ box-shadow:inset 0 0 0 1px rgba(0,0,0,0.16); }
.cg-wave{ position:absolute; left:0; top:0; width:800px; height:16px; animation:cg-wave 1.8s linear infinite; }
.cg-wave.b{ animation-duration:2.6s; animation-direction:reverse; }
.cg-wave path{ fill:rgba(255,255,255,0.30); }
.cg-wave.b path{ fill:rgba(255,255,255,0.18); }
.cg-drain{ position:absolute; top:0; bottom:0; left:0; width:60%; background:linear-gradient(90deg,transparent,rgba(255,255,255,0.45),transparent); animation:cg-drain 1.8s ease-in-out infinite; }
.cg-sail{ position:absolute; top:0; bottom:0; background:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 6px); z-index:1; }
.cg-tick{ position:absolute; top:0; bottom:0; width:2px; margin-left:-1px; border-radius:1px; background:var(--fg); z-index:2; }
.cg-labels{ position:relative; height:16px; margin-top:4px; font-size:11px; color:var(--fg3); }
.cg-labels span{ position:absolute; top:0; white-space:nowrap; }

.cg-sum{ margin-top:8px; font-size:13px; }
.cg-next{ margin-top:4px; font-size:12px; color:var(--fg2); display:flex; gap:6px; align-items:flex-start; }
.cg-next svg{ flex:none; margin-top:1px; }
.cg-warn{ display:flex; gap:8px; margin-top:8px; padding:8px 12px; border-radius:12px; background:rgba(255,69,58,0.16); font-size:12px; }
.cg-warn svg{ flex:none; color:var(--redt); margin-top:1px; }
.cg-wrap{ --redt:#FF6961; }
.cg-wrap[data-tone=light]{ --redt:#C4001A; }

.cg-tl{ margin-top:12px; }
.cg-tltrack{ position:relative; height:8px; border-radius:4px; background:var(--track); }
.cg-tlwin{ position:absolute; top:0; bottom:0; border-radius:4px; background:#0A84FF; opacity:.55; }
.cg-tlmark{ position:absolute; top:-3px; bottom:-3px; width:4px; margin-left:-2px; border-radius:2px; background:#0A84FF; }
.cg-tlnow{ position:absolute; top:50%; width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; background:var(--fg); border:2px solid var(--c); box-shadow:0 0 0 2px var(--bg); transition:left .4s ease-out; }
.cg-tllab{ position:relative; height:16px; margin-top:6px; font-size:11px; color:var(--fg3); }
.cg-tllab span{ position:absolute; top:0; white-space:nowrap; }

.cg-foot{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:12px; color:var(--fg2); }
.cg-foot > span{ display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.cg-foot .hot{ color:var(--redt); font-weight:600; }
.cg-acts{ display:flex; gap:8px; margin-top:12px; }
.cg-btn{ position:relative; flex:1; height:32px; padding:0 8px; border-radius:10px; background:var(--btn); font-size:12px; font-weight:600; white-space:nowrap;
  display:inline-flex; align-items:center; justify-content:center; gap:6px; transition:background .2s ease-out, opacity .2s ease-out; }
.cg-btn:hover{ background:var(--btnh); }
.cg-btn:disabled{ opacity:.45; cursor:default; }
.cg-btn.pri{ background:#0066D6; color:#fff; }
.cg-btn.pri:hover{ background:#0a74ee; }
.cg-btn.warn{ background:rgba(255,69,58,0.20); color:var(--redt); }
.cg-btn.sm{ flex:none; height:28px; padding:0 12px; }
.cg-pend{ opacity:.6; }
.cg-btn.cg-pend{ pointer-events:none; }
.cg-btn.cg-pend::after{ content:""; width:10px; height:10px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:cg-spin .8s linear infinite; }
.cg-toast{ margin-top:8px; font-size:12px; color:var(--redt); animation:cg-fade .3s ease-out; }

.cg-drawer{ background:var(--bg); -webkit-backdrop-filter:blur(24px) saturate(140%); backdrop-filter:blur(24px) saturate(140%);
  border:1px solid var(--bd); border-radius:22px; padding:16px; box-shadow:var(--shadow); overflow-y:auto; min-height:160px; animation:cg-rise .3s ease-out; }
.cg-dh{ display:flex; align-items:center; justify-content:space-between; font-size:15px; font-weight:600; margin-bottom:4px; }
.cg-sec{ padding:12px 0; border-top:1px solid var(--line); }
.cg-sec:first-of-type{ border-top:0; }
.cg-sec h3{ font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--fg3); margin-bottom:8px; }
.cg-help{ font-size:11px; color:var(--fg3); margin-top:6px; }
.cg-row{ display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:32px; font-size:13px; }
.cg-row + .cg-row{ margin-top:4px; }
.cg-row .l{ min-width:0; }
.cg-row .l small{ display:block; font-size:11px; color:var(--fg3); }
.cg-sw{ position:relative; width:40px; height:24px; border-radius:12px; background:var(--ctl); flex:none; transition:background .2s ease-out; }
.cg-sw::after{ content:""; position:absolute; top:2px; left:2px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.3); transition:transform .2s ease-out; }
.cg-sw[aria-checked=true]{ background:#248A3D; }
.cg-sw[aria-checked=true]::after{ transform:translateX(16px); }
.cg-themes{ display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin:8px 0 4px; }
.cg-themes button{ display:flex; flex-direction:column; align-items:center; gap:4px; padding:6px 0; border-radius:10px;
  font-size:11px; font-weight:600; color:var(--fg2); transition:background .2s ease-out; }
.cg-themes button:hover{ background:var(--btn); }
.cg-themes button[aria-checked=true]{ background:var(--segon); color:var(--fg); }
.cg-themes i{ width:24px; height:24px; border-radius:50%; border:1px solid var(--bd); box-shadow:inset 0 0 0 1px rgba(127,127,127,.35); }
.cg-seg{ display:inline-flex; gap:2px; padding:2px; border-radius:10px; background:var(--btn); flex:none; }
.cg-seg button{ min-width:44px; height:28px; padding:0 10px; border-radius:8px; font-size:12px; font-weight:600; color:var(--fg2); transition:background .2s ease-out; }
.cg-seg button[aria-checked=true]{ background:var(--segon); color:var(--fg); box-shadow:0 1px 2px rgba(0,0,0,.25); }
.cg-days{ display:flex; gap:4px; }
.cg-day{ width:32px; height:28px; border-radius:8px; background:var(--btn); font-size:12px; font-weight:600; color:var(--fg2); transition:background .2s ease-out; }
.cg-day[aria-pressed=true]{ background:#0066D6; color:#fff; }
.cg-step{ display:inline-flex; align-items:center; border-radius:10px; background:var(--btn); flex:none; }
.cg-step button{ width:28px; height:28px; font-size:16px; line-height:1; border-radius:10px; }
.cg-step button:hover{ background:var(--btnh); }
.cg-step button:disabled{ opacity:.35; cursor:default; }
.cg-step output{ min-width:56px; text-align:center; font-size:13px; font-weight:600; }
.cg-off{ opacity:.45; }
.cg-plrow{ display:flex; align-items:center; gap:8px; min-height:40px; }
.cg-plrow > svg{ flex:none; color:var(--fg2); }
.cg-plrow .t{ flex:1; min-width:0; font-size:13px; }
.cg-plrow .t small{ display:block; font-size:11px; color:var(--fg3); }
.cg-plrow + .cg-plrow{ margin-top:4px; }
.cg-note{ padding:8px 12px; margin-bottom:8px; border-radius:10px; background:var(--btn); font-size:12px; color:var(--fg2); }
.cg-sched{ display:flex; align-items:center; gap:8px; min-height:32px; font-size:12px; }
.cg-sched .t{ flex:1; min-width:0; }
.cg-sched .t small{ color:var(--fg3); font-size:11px; margin-left:4px; }
.cg-add{ margin-top:8px; padding-top:8px; border-top:1px dashed var(--line); display:flex; flex-direction:column; gap:8px; }
.cg-add .cg-row{ margin:0; }

@keyframes cg-wave{ from{ transform:translateX(0); } to{ transform:translateX(-40px); } }
@keyframes cg-drain{ from{ transform:translateX(120%); } to{ transform:translateX(-120%); } }
@keyframes cg-ring{ from{ stroke-dashoffset:126; } to{ stroke-dashoffset:0; } }
@keyframes cg-fade{ from{ opacity:0; } to{ opacity:1; } }
@keyframes cg-rise{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:none; } }
@keyframes cg-spin{ to{ transform:rotate(360deg); } }
@keyframes cg-pulse{ 0%,100%{ opacity:.35; } 50%{ opacity:.9; } }

@media (prefers-reduced-motion: reduce){
  .cg-wave,.cg-drain{ display:none; }
  .cg-card.cg-plug{ transform:none; }
  .cg-card,.cg-ib svg,.cg-fill,.cg-tlnow{ transition:none; }
  .cg-bi .cg-ringsvg circle{ animation:cg-fade .3s ease-out; }
  .cg-alert,.cg-banner,.cg-drawer{ animation:cg-fade .3s ease-out; }
  .cg-spin,.cg-btn.cg-pend::after{ animation:cg-pulse 1.2s ease-in-out infinite; border-right-color:currentColor; }
}
`;

// ---------------------------------------------------------------------------
// Mode view model. Color, icon, and word. Never color only.
// ---------------------------------------------------------------------------

const GREEN = { c: "#30D158", cl: "#167A32" };
const YELLOW = { c: "#FFD60A", cl: "#7A5C00" };
const BLUE = { c: "#0A84FF", cl: "#0A5FCC" };
const TEAL = { c: "#64D2FF", cl: "#0A6F8F" };
const RED = { c: "#FF453A", cl: "#C4001A" };
const GRAY = { c: "#8E8E93", cl: "#5F5F64" };

const MODE = {
  holding: { ...GREEN, icon: "check" },
  sailing: { ...GREEN, icon: "leaf" },
  charging: { ...YELLOW, icon: "bolt" },
  topup: { ...BLUE, icon: "bolt" },
  discharging: { ...TEAL, icon: "down" },
  calibrating: { ...TEAL, icon: "battery" },
  heat: { ...RED, icon: "thermo" },
  paused: { ...GRAY, icon: "pause" },
  unplugged: { ...GRAY, icon: "battery" },
  error: { ...RED, icon: "warn" },
};

const CAL_STEPS = ["drain", "fill", "hold", "settle"];

function viewOf(st, now) {
  const d = st.decision;
  const s = st.snapshot;
  const m = MODE[d.mode] || MODE.error;
  const ov = st.state.override;
  let title = "";
  let sub = "";
  switch (d.mode) {
    case "holding":
      if (s.percent > d.target + 1) {
        title = `Lowering to ${d.target}%`;
        sub = "Charger connected. The Mac uses the battery first.";
      } else {
        title = `Holding at ${d.target}%`;
        sub = "Charger connected. Charging is off.";
      }
      break;
    case "sailing":
      title = `Sailing at ${Math.round(s.percent)}%`;
      sub = "Charging is off until the sail gap.";
      break;
    case "charging":
      title = `Charging to ${d.target}%`;
      sub = s.minutesToFull != null ? `${cap(fmtSpan(s.minutesToFull))} to full.` : "";
      break;
    case "topup":
      title = `Top-up to ${d.target}%`;
      sub = s.minutesToFull != null ? `${cap(fmtSpan(s.minutesToFull))} to full.` : "";
      break;
    case "discharging":
      title = `Discharging to ${d.target}%`;
      sub = "The Mac uses the battery on the charger.";
      break;
    case "calibrating": {
      const step = ov && ov.step;
      const idx = Math.max(0, CAL_STEPS.indexOf(step));
      const words = {
        drain: "Calibration: drain to 15%",
        fill: "Calibration: charge to 100%",
        hold: "Calibration: hold at 100%",
        settle: `Calibration: settle to ${d.target}%`,
      };
      title = words[step] || "Calibration";
      sub = `Step ${idx + 1} of 4.`;
      if (step === "hold" && ov.stepStartedAt) {
        const left = Math.max(0, 60 - Math.floor((now - Date.parse(ov.stepStartedAt)) / 60000));
        sub += ` About ${left} min left.`;
      }
      break;
    }
    case "heat":
      title = s.tempC != null ? `Heat pause at ${s.tempC.toFixed(1)} °C` : "Heat pause";
      sub = `Charging starts again at ${st.config.heat.resumeC} °C.`;
      break;
    case "paused":
      title = "Paused";
      sub = "macOS controls charging now.";
      break;
    case "unplugged":
      title = "On battery";
      sub = s.minutesToEmpty != null ? `${cap(fmtSpan(s.minutesToEmpty))} left.` : "";
      break;
    default:
      title = "Fail-safe active";
      sub = "Charging follows macOS.";
  }
  return { ...m, title, sub };
}

function cap(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function plugText(st) {
  const d = st.decision;
  const o = st.office;
  const label = st.placeLabel;
  if (d.place === "offline") return "Plugged in. No network. I will charge to 100%.";
  if (d.place === "away") return "Plugged in. Away. I will charge to 100%.";
  if (d.target >= 100) return `Plugged in at ${label}. I will charge to 100%.`;
  if (d.place === "office" && o && o.topupStart && o.end) {
    return `Plugged in at ${label}. Holds ${d.target}% until ${hhmm(o.topupStart)}, then charges to 100% for ${hhmm(o.end)}.`;
  }
  return `Plugged in at ${label}. I will stop at ${d.target}%.`;
}

function unplugText(st) {
  const s = st.snapshot;
  const left = s.minutesToEmpty != null ? ` ${cap(fmtSpan(s.minutesToEmpty))} left.` : "";
  return `On battery. ${Math.round(s.percent)}%.${left}`;
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

const Btn = ({ cx, pk, onClick, disabled, kind, title, children }) => {
  const pending = pk && cx.pend(pk);
  return (
    <button
      type="button"
      className={"cg-btn" + (kind ? " " + kind : "") + (pending ? " cg-pend" : "")}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-busy={pending ? "true" : undefined}
    >
      {children}
    </button>
  );
};

const Toggle = ({ cx, pk, label, on, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={on ? "true" : "false"}
    aria-label={label}
    className={"cg-sw" + (cx.pend(pk) ? " cg-pend" : "")}
    onClick={() => onChange(!on)}
  />
);

// Widget corners. "a" is the name for screen readers, because "t" is only an arrow.
const CORNERS = [
  { v: "top-left", t: "↖", a: "Top left" },
  { v: "top-right", t: "↗", a: "Top right" },
  { v: "bottom-left", t: "↙", a: "Bottom left" },
  { v: "bottom-right", t: "↘", a: "Bottom right" },
];

const Seg = ({ cx, pk, label, options, value, onChange }) => (
  <div className={"cg-seg" + (pk && cx.pend(pk) ? " cg-pend" : "")} role="radiogroup" aria-label={label}>
    {options.map((o) => (
      <button
        key={o.v}
        type="button"
        role="radio"
        aria-label={o.a}
        title={o.a}
        aria-checked={o.v === value ? "true" : "false"}
        onClick={() => onChange(o.v)}
      >
        {o.t}
      </button>
    ))}
  </div>
);

const Stepper = ({ cx, pk, label, value, min, max, step, big, fmt, onSet }) => {
  const go = (dir, e) => onSet(clamp(value + dir * (e.shiftKey && big ? big : step), min, max));
  return (
    <div className={"cg-step" + (pk && cx.pend(pk) ? " cg-pend" : "")} role="group" aria-label={label}>
      <button type="button" aria-label={`Decrease ${label}`} title={big ? "Hold Shift for bigger steps" : undefined} disabled={value <= min} onClick={(e) => go(-1, e)}>
        −
      </button>
      <output className="cg-num" aria-live="polite">{fmt ? fmt(value) : value}</output>
      <button type="button" aria-label={`Increase ${label}`} title={big ? "Hold Shift for bigger steps" : undefined} disabled={value >= max} onClick={(e) => go(1, e)}>
        +
      </button>
    </div>
  );
};

const Row = ({ label, help, off, children }) => (
  <div className={"cg-row" + (off ? " cg-off" : "")}>
    <div className="l">
      {label}
      {help ? <small>{help}</small> : null}
    </div>
    {children}
  </div>
);

const Section = ({ title, help, children }) => (
  <section className="cg-sec">
    <h3>{title}</h3>
    {children}
    {help ? <p className="cg-help">{help}</p> : null}
  </section>
);

// ---------------------------------------------------------------------------
// Main card parts
// ---------------------------------------------------------------------------

const PLACE_ICON = { home: "house", office: "building", away: "globe", offline: "plane" };

const Header = ({ cx, st, view }) => {
  const d = st.decision;
  const manual = (st.config.placeMode || "auto") !== "auto";
  const badge = manual
    ? "set by hand"
    : d.place === "offline" ? "no network" : d.place === "away" ? "unknown router" : "router saved";
  const open = cx.state.drawer;
  return (
    <div className="cg-head">
      <div className="cg-place">
        <Icon n={PLACE_ICON[d.place] || "globe"} s={18} />
        <span>{st.placeLabel}</span>
        <small>· {badge}</small>
      </div>
      <button
        type="button"
        className="cg-ib"
        aria-label={open ? "Close settings" : "Open settings"}
        aria-expanded={open ? "true" : "false"}
        onClick={() => cx.dispatch({ type: "CG_DRAWER" })}
      >
        <Icon n="gear" s={16} />
      </button>
    </div>
  );
};

const Bar = ({ st }) => {
  const d = st.decision;
  const s = st.snapshot;
  const pct = clamp(Math.round(s.percent), 0, 100);
  const t = clamp(d.target, 0, 100);
  const sail = st.config.sail;
  const wave = d.mode === "charging" || d.mode === "topup" || (d.mode === "calibrating" && s.charging);
  const draining = d.mode === "discharging" || (d.mode === "calibrating" && d.adapter === false);
  const showTick = d.mode !== "paused" && d.mode !== "error";
  const band = ["holding", "sailing", "charging", "heat"].indexOf(d.mode) >= 0 && t < 100 && sail > 0;
  const from = Math.max(0, t - sail);
  const word = d.mode === "discharging" || d.mode === "calibrating" ? "target" : "limit";
  let labels = null;
  if (showTick) {
    if (band && t > 85) {
      labels = <span style={{ right: `${100 - t}%` }}>{`sail ${from}% · ${word} ${t}%`}</span>;
    } else if (band) {
      labels = (
        <React.Fragment>
          <span style={{ right: `${100 - from}%`, paddingRight: 4 }}>{`sail ${from}%`}</span>
          <span style={{ left: `${t}%`, paddingLeft: 4 }}>{`${word} ${t}%`}</span>
        </React.Fragment>
      );
    } else if (t > 85) {
      labels = <span style={{ right: `${100 - t}%` }}>{`${word} ${t}%`}</span>;
    } else {
      labels = <span style={{ left: `${t}%`, paddingLeft: 4 }}>{`${word} ${t}%`}</span>;
    }
  }
  return (
    <div>
      <div className="cg-barw">
        <div className="cg-bar" role="progressbar" aria-label="Battery level" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
          <div className="cg-fill" style={{ width: `${pct}%` }}>
            {wave ? (
              <svg className="cg-wave" viewBox="0 0 800 16" preserveAspectRatio="none" aria-hidden="true">
                <path d={WAVE_D} />
              </svg>
            ) : null}
            {wave ? (
              <svg className="cg-wave b" viewBox="0 0 800 16" preserveAspectRatio="none" aria-hidden="true">
                <path d={WAVE_D} />
              </svg>
            ) : null}
            {draining ? <div className="cg-drain" /> : null}
          </div>
          {band ? <div className="cg-sail" style={{ left: `${from}%`, width: `${t - from}%` }} /> : null}
        </div>
        {showTick ? <div className="cg-tick" style={{ left: `${t}%` }} /> : null}
      </div>
      {showTick ? <div className="cg-labels">{labels}</div> : <div style={{ height: 8 }} />}
    </div>
  );
};

const Timeline = ({ st, now }) => {
  const o = st.office;
  const oh = st.config.officeHours;
  if (st.decision.place !== "office" || !o || !o.end) return null;
  const endMs = Date.parse(o.end);
  const startMs = endMs - (toMin(oh.end) - toMin(oh.start)) * 60000;
  const span = Math.max(1, endMs - startMs);
  const f = (ms) => clamp(((ms - startMs) / span) * 100, 0, 100);
  const nowP = f(now);
  const topP = o.topupStart ? f(Date.parse(o.topupStart)) : null;
  const label = `Office day. Start ${oh.start}. ${o.topupStart ? "Top-up " + hhmm(o.topupStart) + ". " : ""}End ${hhmm(o.end)}.`;
  return (
    <div className="cg-tl" role="img" aria-label={label}>
      <div className="cg-tltrack">
        {topP != null ? <div className="cg-tlwin" style={{ left: `${topP}%`, right: 0 }} /> : null}
        {topP != null ? <div className="cg-tlmark" style={{ left: `${topP}%` }} /> : null}
        <div className="cg-tlnow" style={{ left: `${nowP}%` }} />
      </div>
      <div className="cg-tllab">
        <span style={{ left: 0 }}>{oh.start}</span>
        {topP != null ? (
          <span style={{ left: `clamp(24%, ${topP}%, 76%)`, transform: "translateX(-50%)" }}>
            {`top-up ${hhmm(o.topupStart)}`}
          </span>
        ) : null}
        <span style={{ right: 0 }}>{hhmm(o.end)}</span>
      </div>
    </div>
  );
};

function slowAdvice(o) {
  const need = o.etaMin != null ? Math.round(o.etaMin) : null;
  const lead = need != null ? clamp(Math.ceil(need / 30) * 30, 30, 240) : null;
  let t = "The charger is too slow to reach 100% in time.";
  if (need != null) t += ` Full charge needs ${fmtSpan(need)}.`;
  if (lead != null) t += ` Use a lead time of ${lead} min.`;
  return { text: t, lead };
}

const Alerts = ({ cx, st, stopped, setup, plugAge, unplugAge }) => {
  const d = st.decision;
  const out = [];
  if (stopped) {
    const age = cx.now - Date.parse(st.updatedAt);
    out.push(
      <div className="cg-alert" key="stop" role="alert" style={{ "--cbg": "rgba(255,69,58,0.16)", "--ct": "var(--redt)" }}>
        <Icon n="warn" s={18} />
        <div>
          <b>ChargeGuard stopped</b>
          <span>{`No update for ${ageText(age)}. The numbers below are old.`}</span>
          <div className="cg-acts">
            <Btn cx={cx} pk="start" kind="pri" onClick={() => startDaemon(cx, st.updatedAt)}>
              Start ChargeGuard
            </Btn>
          </div>
        </div>
      </div>
    );
  }
  if (setup) {
    out.push(
      <div className="cg-alert" key="setup" style={{ "--cbg": "rgba(255,159,10,0.18)", "--ct": "var(--redt)" }}>
        <Icon n="warn" s={18} />
        <div style={{ minWidth: 0 }}>
          <b>One-time setup needed</b>
          <span>Open Terminal. Run this command. It asks for your password one time.</span>
          <code className="cg-code">{SETUP_CMD}</code>
          <div className="cg-acts">
            <Btn cx={cx} kind="sm" onClick={() => copySetup(cx)}>
              Copy command
            </Btn>
          </div>
        </div>
      </div>
    );
  }
  if (d.mode === "error") {
    out.push(
      <div className="cg-alert" key="err" role="alert" style={{ "--cbg": "rgba(255,69,58,0.16)", "--ct": "var(--redt)" }}>
        <Icon n="warn" s={18} />
        <div>
          <b>Fail-safe active</b>
          <span>{st.health.lastError || "ChargeGuard cannot control the battery. Charging follows macOS."}</span>
        </div>
      </div>
    );
  }
  if (!stopped && plugAge != null) {
    out.push(
      <div className="cg-banner" key={"plug" + st.state.lastPlugAt} data-out={plugAge > PLUG_MS - 800 ? "true" : "false"} role="status" aria-live="polite">
        <Icon n="plug" s={18} />
        <span>{plugText(st)}</span>
      </div>
    );
  }
  if (!stopped && unplugAge != null) {
    out.push(
      <div className="cg-banner" key={"unplug" + st.state.lastUnplugAt} data-out={unplugAge > UNPLUG_MS - 800 ? "true" : "false"} role="status" aria-live="polite">
        <Icon n="battery" s={18} />
        <span>{unplugText(st)}</span>
      </div>
    );
  }
  return out;
};

function startDaemon(cx, oldStamp) {
  cx.act("start", KICK_CMD, { path: "updatedAt", op: "neq", val: oldStamp }, true);
}

function copySetup(cx) {
  run("printf %s '" + SETUP_CMD + "' | pbcopy")
    .then(() => cx.toast("Command copied."))
    .catch(() => cx.toast("Copy failed. Type the command in Terminal."));
}

const Actions = ({ cx, st, off }) => {
  const d = st.decision;
  const s = st.snapshot;
  const ov = st.state.override;
  const limit = placeLimit(st);
  const none = { path: "state.override", op: "eq", val: null };

  if (d.mode === "calibrating") {
    return (
      <div className="cg-acts">
        <Btn cx={cx} pk="cal" disabled={off} onClick={() => cx.act("cal", `${CG} calibrate stop`, none, true)}>
          Stop calibration
        </Btn>
      </div>
    );
  }

  const topupOn = !!ov && ov.kind === "topup";
  const topupAuto = d.mode === "topup" && !topupOn;
  const dischargeOn = !!ov && ov.kind === "discharge";
  const paused = (!!ov && ov.kind === "pause") || d.mode === "paused";
  const armed = cx.confirming("discharge");

  const away = d.place === "away" || d.place === "offline";

  return (
    <div>
      {d.place === "away" && (st.config.placeMode || "auto") === "auto" ? (
        <div className="cg-acts">
          <Btn cx={cx} pk="save-home" kind="pri" disabled={off || !s.routerMac} onClick={() => savePlace(cx, st, "home")}>
            Save as Home
          </Btn>
          <Btn cx={cx} pk="save-office" kind="pri" disabled={off || !s.routerMac} onClick={() => savePlace(cx, st, "office")}>
            Save as Office
          </Btn>
        </div>
      ) : null}
      <div className="cg-acts">
        {away && d.target >= 100 && !topupOn ? null : topupOn ? (
          <Btn cx={cx} pk="topup" disabled={off} onClick={() => cx.act("topup", `${CG} topup stop`, none, true)}>
            Stop top-up
          </Btn>
        ) : (
          <Btn
            cx={cx}
            pk="topup"
            disabled={off || topupAuto || !s.ac}
            title={topupAuto ? "Office hours already charge to 100%." : !s.ac ? "Connect the charger first." : "Charge to 100% one time."}
            onClick={() => cx.act("topup", `${CG} topup`, { path: "state.override.kind", op: "eq", val: "topup" }, true)}
          >
            {topupAuto ? "Top-up is on" : "Top up to 100%"}
          </Btn>
        )}
        {dischargeOn ? (
          <Btn cx={cx} pk="discharge" disabled={off} onClick={() => cx.act("discharge", `${CG} discharge stop`, none, true)}>
            Stop discharge
          </Btn>
        ) : (
          <Btn
            cx={cx}
            pk="discharge"
            kind={armed ? "warn" : ""}
            disabled={off || !s.ac || s.percent <= limit}
            title={!s.ac ? "Connect the charger first." : s.percent <= limit ? `The battery is at or below ${limit}%.` : `Use the battery until ${limit}%.`}
            onClick={() =>
              cx.confirmTap("discharge", () =>
                cx.act("discharge", `${CG} discharge ${limit}`, { path: "state.override.kind", op: "eq", val: "discharge" }, true)
              )
            }
          >
            {armed ? "Tap again to confirm" : "Discharge"}
          </Btn>
        )}
        {paused ? (
          <Btn cx={cx} pk="pause" disabled={off} onClick={() => cx.act("pause", `${CG} resume`, none, true)}>
            <Icon n="play" s={12} /> Resume
          </Btn>
        ) : (
          <Btn cx={cx} pk="pause" disabled={off} onClick={() => cx.act("pause", `${CG} pause`, { path: "state.override.kind", op: "eq", val: "pause" }, true)}>
            <Icon n="pause" s={12} /> Pause
          </Btn>
        )}
      </div>
    </div>
  );
};

function savePlace(cx, st, id) {
  cx.act(
    "save-" + id,
    `${CG} place save ${id}`,
    { path: `config.places.${id}.routers`, op: "has", val: st.snapshot.routerMac },
    true
  );
}

const Footer = ({ st }) => {
  const s = st.snapshot;
  const hot = s.tempC != null && st.config.heat.enabled && s.tempC >= st.config.heat.maxC;
  const w = s.adapterWatts;
  return (
    <div className="cg-foot cg-num">
      <span className={hot ? "hot" : ""} title="Battery temperature">
        <Icon n="thermo" s={14} />
        {s.tempC != null ? `${Math.round(s.tempC)} °C` : "– °C"}
      </span>
      <span title="Charger power">
        <Icon n="plug" s={14} />
        {w == null ? "No charger" : `${Math.round(w)} W charger${w < 30 ? " (slow)" : ""}`}
      </span>
      <span title="Battery health">
        <Icon n="leaf" s={14} />
        {s.healthPct != null ? `${Math.round(s.healthPct)}% health` : "– health"}
      </span>
    </div>
  );
};

const Card = ({ cx }) => {
  const { st, now } = cx;
  const s = st.snapshot;
  const d = st.decision;
  const age = now - Date.parse(st.updatedAt);
  const stopped = !(age <= STALE_MS) || st.health.daemon === false;
  const setup = st.health.helper === false;
  const view = viewOf(st, now);

  const plugT = st.state.lastPlugAt ? now - Date.parse(st.state.lastPlugAt) : null;
  const plugAge = s.ac && plugT != null && plugT >= -2000 && plugT < PLUG_MS ? plugT : null;
  const unT = st.state.lastUnplugAt ? now - Date.parse(st.state.lastUnplugAt) : null;
  const unplugAge = !s.ac && unT != null && unT >= -2000 && unT < UNPLUG_MS ? unT : null;

  const applied = st.health.appliedLimit == null ? 100 : st.health.appliedLimit;
  const applying = !stopped && st.health.backend === "native" && applied !== d.nativeLimit;

  const toast = cx.state.toast && now - cx.state.toast.at < TOAST_MS ? cx.state.toast.text : null;
  const pct = Math.round(s.percent);
  const style = {
    "--c": view.c,
    "--cl": view.cl,
    "--cbg": view.c + "26",
  };
  const slow = st.office && st.office.tooSlow && d.place === "office";
  const advice = slow ? slowAdvice(st.office) : null;
  const noNet = d.place === "offline" || !s.routerMac;
  const showAway = d.place === "away" || d.place === "offline";

  return (
    <div className={"cg-card" + (plugAge != null ? " cg-plug" : "")} style={style}>
      <Header cx={cx} st={st} view={view} />
      <Alerts cx={cx} st={st} stopped={stopped} setup={setup} plugAge={plugAge} unplugAge={unplugAge} />
      <div className="cg-body" data-dim={stopped ? "true" : "false"}>
        <div className="cg-main">
          <div className="cg-bi">
            {plugAge != null ? (
              <svg className="cg-ringsvg" key={"ring" + st.state.lastPlugAt} viewBox="0 0 44 44" aria-hidden="true">
                <circle cx="22" cy="22" r="20" />
              </svg>
            ) : null}
            <Icon n="battery" s={28} />
          </div>
          <div className="cg-pct cg-num" aria-label={`Battery ${pct} percent`}>
            {pct}
            <span>%</span>
          </div>
          <div className="cg-mb">
            <div className="cg-mode">
              <Icon n={view.icon} s={16} />
              <span>{view.title}</span>
            </div>
            {view.sub ? <div className="cg-sub">{view.sub}</div> : null}
            {applying ? (
              <div className="cg-apply" role="status" aria-live="polite">
                <span className="cg-spin" /> Applying…
              </div>
            ) : null}
          </div>
        </div>

        <Bar st={st} />

        {showAway ? (
          <p className="cg-sum">
            <b>{noNet ? "No network. Charges to 100%." : "Away. Charges to 100%."}</b>{" "}
            {noNet ? "Connect to Wi-Fi to find the place." : "Save this network to use a limit here."}
          </p>
        ) : (
          <p className="cg-sum">{d.summary}</p>
        )}
        {st.next ? (
          <p className="cg-next">
            <Icon n="clock" s={14} />
            <span>{st.next}</span>
          </p>
        ) : null}
        <Timeline st={st} now={now} />
        {advice ? (
          <div className="cg-warn" role="alert">
            <Icon n="warn" s={16} />
            <span>{advice.text}</span>
          </div>
        ) : null}

        <Footer st={st} />
        <Actions cx={cx} st={st} off={stopped} />
        {toast ? (
          <p className="cg-toast" role="status">
            {toast}
          </p>
        ) : null}
      </div>
    </div>
  );
};

const EmptyCard = ({ cx }) => {
  const style = { "--c": GRAY.c, "--cl": GRAY.cl, "--cbg": GRAY.c + "26" };
  return (
    <div className="cg-card" style={style}>
      <div className="cg-head">
        <div className="cg-place">
          <Icon n="battery" s={18} />
          <span>ChargeGuard</span>
        </div>
      </div>
      <div className="cg-alert" role="status" style={{ "--cbg": "rgba(142,142,147,0.20)", "--ct": "var(--fg2)" }}>
        <Icon n="warn" s={18} />
        <div>
          <b>Waiting for ChargeGuard</b>
          <span>No status file found. Start ChargeGuard. If it does not start, run the install script.</span>
          <div className="cg-acts">
            <Btn cx={cx} pk="start" kind="pri" onClick={() => startDaemon(cx, null)}>
              Start ChargeGuard
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Settings drawer
// ---------------------------------------------------------------------------

const PlaceRow = ({ cx, st, id }) => {
  const p = st.config.places[id];
  const mac = st.snapshot.routerMac;
  const has = !!mac && p.routers.indexOf(mac) >= 0;
  const n = p.routers.length;
  const info = n === 0 ? "No router saved" : `${n} router${n > 1 ? "s" : ""}, ${shortMac(p.routers[0])}`;
  return (
    <div className="cg-plrow">
      <Icon n={PLACE_ICON[id]} s={18} />
      <div className="t">
        {p.label}
        <small>{info}</small>
      </div>
      <Btn cx={cx} pk={"save-" + id} kind="sm" disabled={!mac || has} onClick={() => savePlace(cx, st, id)}>
        {has ? "Saved" : "Use current Wi-Fi"}
      </Btn>
      {n > 0 ? (
        <Btn
          cx={cx}
          pk={"forget-" + id}
          kind="sm"
          onClick={() =>
            cx.act("forget-" + id, `${CG} place forget ${id}`, { path: `config.places.${id}.routers.length`, op: "eq", val: 0 }, true)
          }
        >
          Forget
        </Btn>
      ) : null}
    </div>
  );
};

const PLACE_MODES = [
  { v: "auto", t: "Auto" },
  { v: "home", t: "Home" },
  { v: "office", t: "Office" },
  { v: "away", t: "Away" },
];

const PlacesSection = ({ cx, st }) => {
  const mode = cx.val("place-use", st.config.placeMode || "auto");
  const mac = st.snapshot.routerMac;
  const home = st.config.places.home.routers.indexOf(mac) >= 0;
  const office = st.config.places.office.routers.indexOf(mac) >= 0;
  let note;
  if (!mac) note = "No network. Connect to Wi-Fi to save a place.";
  else if (home) note = `Current router ${mac}. It matches ${st.config.places.home.label}.`;
  else if (office) note = `Current router ${mac}. It matches ${st.config.places.office.label}.`;
  else note = `Current router ${mac}. It does not match a saved place.`;
  return (
    <Section title="Places" help="ChargeGuard finds the place by the router. A place can have more than one router.">
      <Row label="Place" help={mode === "auto" ? "Auto uses the router." : "Set by hand. Choose Auto to use the router again."}>
        <Seg
          cx={cx}
          pk="place-use"
          label="Place"
          value={mode}
          options={PLACE_MODES}
          onChange={(v) => cx.act("place-use", `${CG} place use ${v}`, { path: "config.placeMode", op: "eq", val: v }, v)}
        />
      </Row>
      <div className="cg-note">{note}</div>
      <PlaceRow cx={cx} st={st} id="home" />
      <PlaceRow cx={cx} st={st} id="office" />
    </Section>
  );
};

const LimitSection = ({ cx, st }) => {
  const v = cx.val("limit", st.config.limit);
  return (
    <Section title="Charge limit" help="80% is best for battery life if the Mac is often on the charger.">
      <Row label="Limit">
        <Seg
          cx={cx}
          pk="limit"
          label="Charge limit"
          value={v}
          options={[{ v: 80, t: "80" }, { v: 90, t: "90" }, { v: 100, t: "100" }]}
          onChange={(n) => limitSet(cx, n)}
        />
      </Row>
      <Row label="Exact value">
        <Stepper cx={cx} pk="limit" label="charge limit" value={v} min={50} max={100} step={1} big={5} fmt={(n) => n + "%"} onSet={(n) => limitSet(cx, n)} />
      </Row>
    </Section>
  );
};

const OfficeSection = ({ cx, st }) => {
  const base = st.config.officeHours;
  const oh = cx.val("oh", base);
  const on = cx.val("oh-on", base.enabled);
  const set = (patch) => officeSet(cx, { days: oh.days, start: oh.start, end: oh.end, leadMin: oh.leadMin, ...patch });
  const toggleDay = (n) => {
    const has = oh.days.indexOf(n) >= 0;
    const days = DAYS.map((x) => x.n).filter((x) => (x === n ? !has : oh.days.indexOf(x) >= 0));
    if (days.length > 0) set({ days });
  };
  const startM = toMin(oh.start);
  const endM = toMin(oh.end);
  return (
    <Section title="Office hours" help="At the Office, the Mac charges to 100% before the end time. Then it goes back to the limit.">
      <Row label="Office hours">
        <Toggle cx={cx} pk="oh-on" label="Office hours" on={on} onChange={(v) => officeToggle(cx, v)} />
      </Row>
      <div className={on ? "" : "cg-off"}>
        <Row label="Days">
          <div className={"cg-days" + (cx.pend("oh") ? " cg-pend" : "")} role="group" aria-label="Office days">
            {DAYS.map((x) => (
              <button
                key={x.n}
                type="button"
                className="cg-day"
                aria-pressed={oh.days.indexOf(x.n) >= 0 ? "true" : "false"}
                aria-label={x.l}
                onClick={() => toggleDay(x.n)}
              >
                {x.s}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Start">
          <Stepper cx={cx} pk="oh" label="start time" value={startM} min={0} max={endM - 15} step={15} fmt={fromMin} onSet={(n) => set({ start: fromMin(n) })} />
        </Row>
        <Row label="End">
          <Stepper cx={cx} pk="oh" label="end time" value={endM} min={startM + 15} max={1439} step={15} fmt={fromMin} onSet={(n) => set({ end: fromMin(n) })} />
        </Row>
        <Row label="Lead time" help="Top-up starts this long before the end.">
          <Seg
            cx={cx}
            pk="oh"
            label="Lead time in minutes"
            value={oh.leadMin}
            options={[{ v: 30, t: "30" }, { v: 60, t: "60" }, { v: 90, t: "90" }, { v: 120, t: "120" }]}
            onChange={(n) => set({ leadMin: n })}
          />
        </Row>
      </div>
    </Section>
  );
};

const ProtectionSection = ({ cx, st }) => {
  const c = st.config;
  const tg = (path, label, help, actual) => (
    <Row label={label} help={help}>
      <Toggle cx={cx} pk={"set:" + path} label={label} on={cx.val("set:" + path, actual)} onChange={(v) => cfgSet(cx, path, v)} />
    </Row>
  );
  const heatOn = cx.val("set:heat.enabled", c.heat.enabled);
  const lpOn = cx.val("set:lowPower.enabled", c.lowPower.enabled);
  return (
    <Section title="Protection">
      {tg("heat.enabled", "Heat protection", "Stops charging when the battery is hot.", c.heat.enabled)}
      <Row label="Pause above" off={!heatOn}>
        <Stepper cx={cx} pk="set:heat.maxC" label="heat limit" value={cx.val("set:heat.maxC", c.heat.maxC)} min={30} max={45} step={1} fmt={(n) => n + " °C"} onSet={(n) => cfgSet(cx, "heat.maxC", n, 450)} />
      </Row>
      <Row label="Sail gap" help="Charging starts again this far below the limit.">
        <Stepper cx={cx} pk="set:sail" label="sail gap" value={cx.val("set:sail", c.sail)} min={0} max={20} step={1} fmt={(n) => n + "%"} onSet={(n) => cfgSet(cx, "sail", n, 450)} />
      </Row>
      {tg("stopChargingWhenSleeping", "Stop charging in sleep", null, c.stopChargingWhenSleeping)}
      {tg("sleepControl", "Sleep control", "Keeps the Mac awake during top-up, discharge, and calibration.", c.sleepControl)}
      {tg("autoDischarge", "Auto discharge", "Uses the battery to reach the limit on the charger.", c.autoDischarge)}
      {tg("dischargeInClamshell", "Discharge in clamshell", "Discharge also runs with the lid closed.", c.dischargeInClamshell)}
      {tg("lowPower.enabled", "Low Power Mode", "Turns on at low battery. Turns off on the charger.", c.lowPower.enabled)}
      <Row label="Turn on below" off={!lpOn}>
        <Stepper cx={cx} pk="set:lowPower.belowPct" label="Low Power Mode level" value={cx.val("set:lowPower.belowPct", c.lowPower.belowPct)} min={5} max={50} step={5} fmt={(n) => n + "%"} onSet={(n) => cfgSet(cx, "lowPower.belowPct", n, 450)} />
      </Row>
    </Section>
  );
};

const CalibrationSection = ({ cx, st }) => {
  const ov = st.state.override;
  const running = !!ov && ov.kind === "calibrate";
  const armed = cx.confirming("calibrate");
  return (
    <Section title="Calibration" help="Drains to 15%, charges to 100%, holds 60 min, then goes back to the limit. It needs the charger.">
      <Row label="Last run" >
        <span className="cg-num">{fmtDate(st.config.lastCalibration)}</span>
      </Row>
      <div className="cg-acts">
        {running ? (
          <Btn cx={cx} pk="cal" onClick={() => cx.act("cal", `${CG} calibrate stop`, { path: "state.override", op: "eq", val: null }, true)}>
            Stop calibration
          </Btn>
        ) : (
          <Btn
            cx={cx}
            pk="cal"
            kind={armed ? "warn" : ""}
            disabled={!st.snapshot.ac}
            title={!st.snapshot.ac ? "Connect the charger first." : undefined}
            onClick={() =>
              cx.confirmTap("calibrate", () =>
                cx.act("cal", `${CG} calibrate`, { path: "state.override.kind", op: "eq", val: "calibrate" }, true)
              )
            }
          >
            {armed ? "Tap again to confirm" : "Start calibration"}
          </Btn>
        )}
      </div>
    </Section>
  );
};

function actionText(a) {
  switch (a.kind) {
    case "topup":
      return "Top up";
    case "calibrate":
      return "Calibrate";
    case "limit":
      return `Limit ${a.value}%`;
    case "discharge":
      return `Discharge to ${a.value}%`;
    default:
      return a.kind;
  }
}

const ScheduleSection = ({ cx, st }) => {
  const rules = st.config.schedule;
  const dr = cx.state.draft;
  const patch = (p) => cx.dispatch({ type: "CG_DRAFT", patch: p });
  const toggle = (n) => {
    const has = dr.days.indexOf(n) >= 0;
    const days = DAYS.map((x) => x.n).filter((x) => (x === n ? !has : dr.days.indexOf(x) >= 0));
    patch({ days });
  };
  const add = () => {
    if (dr.days.length === 0) return;
    const cmd = `${CG} schedule add --days ${dr.days.join(",")} --time ${fromMin(dr.time)} --action ${dr.action}`;
    cx.act("sched-add", cmd, { path: "config.schedule.length", op: "gt", val: rules.length }, true);
  };
  return (
    <Section title="Schedule" help="A rule runs its action at the time on the chosen days.">
      {rules.length === 0 ? <div className="cg-help" style={{ marginTop: 0, marginBottom: 8 }}>No rules yet.</div> : null}
      {rules.map((r) => {
        const names = DAYS.filter((x) => r.days.indexOf(x.n) >= 0).map((x) => x.a).join(" ");
        const okId = /^[A-Za-z0-9_-]+$/.test(r.id);
        return (
          <div className={"cg-sched" + (r.enabled ? "" : " cg-off")} key={r.id}>
            <div className="t">
              <span className="cg-num">{r.time}</span> {actionText(r.action)}
              <small>{names}</small>
            </div>
            <Btn
              cx={cx}
              pk={"sched-rm-" + r.id}
              kind="sm"
              disabled={!okId}
              onClick={() => cx.act("sched-rm-" + r.id, `${CG} schedule rm ${r.id}`, { path: "config.schedule", op: "notHasId", val: r.id }, true)}
            >
              Remove
            </Btn>
          </div>
        );
      })}
      <div className="cg-add">
        <Row label="Days">
          <div className="cg-days" role="group" aria-label="Rule days">
            {DAYS.map((x) => (
              <button
                key={x.n}
                type="button"
                className="cg-day"
                aria-pressed={dr.days.indexOf(x.n) >= 0 ? "true" : "false"}
                aria-label={x.l}
                onClick={() => toggle(x.n)}
              >
                {x.s}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Time">
          <Stepper cx={cx} label="rule time" value={dr.time} min={0} max={1425} step={15} fmt={fromMin} onSet={(n) => patch({ time: n })} />
        </Row>
        <Row label="Action">
          <Seg cx={cx} label="Rule action" value={dr.action} options={[{ v: "topup", t: "Top up" }, { v: "calibrate", t: "Calibrate" }]} onChange={(v) => patch({ action: v })} />
        </Row>
        <div className="cg-acts" style={{ marginTop: 0 }}>
          <Btn cx={cx} pk="sched-add" kind="pri" disabled={dr.days.length === 0} onClick={add}>
            Add rule
          </Btn>
        </div>
      </div>
    </Section>
  );
};

const PANEL_HEIGHTS = [
  { v: 50, t: "50%" },
  { v: 70, t: "70%" },
  { v: 85, t: "85%" },
  { v: 100, t: "Full" },
];

const WidgetSection = ({ cx }) => (
  <Section title="Widget">
    <div className={"cg-themes" + (cx.pend("set:widget.theme") ? " cg-pend" : "")} role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => (
        <button
          key={t.v}
          type="button"
          role="radio"
          aria-checked={t.v === look.theme ? "true" : "false"}
          onClick={() => cfgSet(cx, "widget.theme", t.v)}
        >
          <i style={{ background: t.sw }} />
          {t.t}
        </button>
      ))}
    </div>
    <Row label="Size">
      <Stepper cx={cx} pk="set:widget.scale" label="widget size" value={look.scale} min={SCALE_MIN} max={SCALE_MAX}
        step={5} big={20} fmt={(n) => n + "%"} onSet={(n) => cfgSet(cx, "widget.scale", n, 600)} />
    </Row>
    <Row label="Panel height" help="The most screen height the widget uses with Settings open.">
      <Seg cx={cx} pk="set:widget.panelHeight" label="Panel height" value={look.panelHeight} options={PANEL_HEIGHTS}
        onChange={(v) => cfgSet(cx, "widget.panelHeight", v)} />
    </Row>
    <Row label="Position" help="The Übersicht widget always stays at the bottom left.">
      <Seg cx={cx} pk="set:widget.corner" label="Widget position" value={look.corner} options={CORNERS}
        onChange={(v) => cfgSet(cx, "widget.corner", v)} />
    </Row>
  </Section>
);

const Drawer = ({ cx }) => {
  const { st } = cx;
  const led = cx.val("set:magsafeLed", st.config.magsafeLed);
  return (
    <div className="cg-drawer" style={{ "--c": GRAY.c, "--cl": GRAY.cl }} role="region" aria-label="Settings">
      <div className="cg-dh">
        <span>Settings</span>
        <button type="button" className="cg-ib" aria-label="Close settings" onClick={() => cx.dispatch({ type: "CG_DRAWER" })}>
          <Icon n="close" s={16} />
        </button>
      </div>
      <WidgetSection cx={cx} />
      <PlacesSection cx={cx} st={st} />
      <LimitSection cx={cx} st={st} />
      <OfficeSection cx={cx} st={st} />
      <ProtectionSection cx={cx} st={st} />
      <Section title="MagSafe LED">
        <Row label="Use the LED" help="Green holds. Orange charges. Off discharges.">
          <Toggle cx={cx} pk="set:magsafeLed" label="MagSafe LED" on={led} onChange={(v) => cfgSet(cx, "magsafeLed", v)} />
        </Row>
      </Section>
      <CalibrationSection cx={cx} st={st} />
      <ScheduleSection cx={cx} st={st} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

// The last known corner. It keeps the position while the status file is missing.
let look = { corner: "bottom-left", theme: "auto", scale: 100, panelHeight: 85 };

// Reads the widget look from the config. A pending click shows its new value at once.
function readLook(cx) {
  const w = (cx.st && cx.st.config && cx.st.config.widget) || {};
  look = {
    corner: cx.val("set:widget.corner", w.corner || look.corner),
    theme: cx.val("set:widget.theme", w.theme || look.theme),
    scale: cx.val("set:widget.scale", w.scale || look.scale),
    panelHeight: cx.val("set:widget.panelHeight", w.panelHeight || look.panelHeight),
  };
}

const prefersLight = () =>
  typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;

export const render = (state, dispatch) => {
  const now = nowMs();
  const cx = makeCx(state, dispatch, now);
  const st = state.status;
  if (st && st.config) readLook(cx);
  // The preview page sets __CG_THEME__. It wins over the config.
  const theme = (typeof window !== "undefined" && window.__CG_THEME__) || look.theme;
  const def = THEMES.find((t) => t.v === theme) || THEMES[0];
  const tone = def.tone === "auto" ? (prefersLight() ? "light" : "dark") : def.tone;
  const z = clamp(look.scale, SCALE_MIN, SCALE_MAX) / 100;
  const style = { zoom: z, "--cg-z": z, "--cg-ph": look.panelHeight / 100 };
  return (
    <div className="cg-wrap" data-theme={def.v} data-tone={tone} data-corner={look.corner} style={style}>
      <style>{STYLES}</style>
      {st && state.drawer ? <Drawer cx={cx} /> : null}
      {st ? <Card cx={cx} /> : <EmptyCard cx={cx} />}
    </div>
  );
};
