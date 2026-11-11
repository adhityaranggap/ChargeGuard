// ChargeGuard config and state: defaults, validation, and file storage.
// This file only uses Node built-ins. It never throws for bad values in a config.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  CalibrationStep,
  ClockTime,
  Config,
  MenubarIcon,
  MenubarSection,
  NotifyEvent,
  Override,
  OverrideKind,
  PlaceId,
  PlaceKind,
  PlaceMode,
  RuntimeState,
  ScheduleAction,
  ScheduleRule,
  Weekday,
  WidgetCorner,
  WidgetTheme,
} from "./types";
import { PATHS } from "./types";

export const DEFAULT_CONFIG: Config = {
  version: 1,
  limit: 80,
  sail: 5,
  awayLimit: 100,
  places: {
    home: { label: "Home", routers: [], limit: null },
    office: { label: "Office", routers: [], limit: null },
  },
  placeMode: "auto",
  officeHours: {
    enabled: true,
    days: [1, 2, 3, 4, 5],
    start: "08:00",
    end: "17:00",
    leadMin: 90,
    graceMin: 120,
  },
  heat: { enabled: true, maxC: 35, resumeC: 32 },
  autoDischarge: false,
  dischargeInClamshell: false,
  stopChargingWhenSleeping: true,
  sleepControl: true,
  lowPower: { enabled: false, belowPct: 20 },
  magsafeLed: true,
  schedule: [],
  notifications: {},
  menubar: {
    icon: "battery",
    showPercent: true,
    sections: ["status", "place", "limit", "actions", "officeHours", "schedule", "settings"],
  },
  widget: { corner: "bottom-left", theme: "auto", scale: 100, panelHeight: 85 },
  lastCalibration: null,
};

export const DEFAULT_STATE: RuntimeState = {
  override: null,
  sailing: false,
  heatBlocked: false,
  lastAc: null,
  lastPlace: null,
  lastPlugAt: null,
  lastUnplugAt: null,
  sensorFailures: 0,
  firedRules: [],
  officeTopupNotified: null,
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// Small parsers
// ---------------------------------------------------------------------------

/**
 * Normalize a MAC address to lowercase colon form.
 * Accepts ":" and "-" separators, upper case, and the short macOS arp form.
 * Returns null if the text is not a valid MAC.
 */
export function normalizeMac(s: string): string | null {
  if (typeof s !== "string") return null;
  const text = s.trim();
  if (text === "") return null;
  let parts: string[];
  if (/^[0-9a-fA-F]{12}$/.test(text)) {
    parts = text.match(/.{2}/g) ?? [];
  } else {
    parts = text.split(/[:-]/);
  }
  if (parts.length !== 6) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(p)) return null;
    out.push(p.length === 1 ? "0" + p : p);
  }
  return out.join(":").toLowerCase();
}

/** Parse "HH:MM" into minutes since midnight. Returns null if invalid. */
export function parseClock(s: string): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Format minutes since midnight as "HH:MM". */
export function formatClock(min: number): string {
  const total = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(max, Math.max(min, n));
}

function asBool(v: unknown, def: boolean): boolean {
  return typeof v === "boolean" ? v : def;
}

function asDays(v: unknown, def: Weekday[]): Weekday[] {
  if (!Array.isArray(v)) return [...def];
  const set = new Set<number>();
  for (const x of v) {
    if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 6) set.add(x);
  }
  return [...set].sort((a, b) => a - b) as Weekday[];
}

function asClock(v: unknown, def: ClockTime): ClockTime {
  if (typeof v === "string") {
    const m = parseClock(v);
    if (m !== null) return formatClock(m);
  }
  return def;
}

function asRouters(v: unknown, def: string[]): string[] {
  if (!Array.isArray(v)) return [...def];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const mac = normalizeMac(x);
    if (mac !== null && !out.includes(mac)) out.push(mac);
  }
  return out;
}

function asPlace(raw: unknown, def: Config["places"][PlaceId]): Config["places"][PlaceId] {
  const r = isObj(raw) ? raw : {};
  const label = typeof r.label === "string" && r.label.trim() !== "" ? r.label.trim() : def.label;
  const limit = typeof r.limit === "number" && Number.isFinite(r.limit) ? clampNum(r.limit, 80, 10, 100) : null;
  return { label, routers: asRouters(r.routers, def.routers), limit };
}

function asScheduleRule(raw: unknown): ScheduleRule | null {
  if (!isObj(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.trim() === "") return null;
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return null;
  if (!Array.isArray(raw.days)) return null;
  if (typeof raw.time !== "string") return null;
  const t = parseClock(raw.time);
  if (t === null) return null;
  if (!isObj(raw.action)) return null;
  const a = raw.action;
  let action: ScheduleAction;
  if (a.kind === "topup") action = { kind: "topup" };
  else if (a.kind === "calibrate") action = { kind: "calibrate" };
  else if ((a.kind === "limit" || a.kind === "discharge") && typeof a.value === "number" && Number.isFinite(a.value)) {
    action = { kind: a.kind, value: clampNum(a.value, 80, 10, 100) };
  } else return null;
  return {
    id: raw.id.trim(),
    enabled: raw.enabled === undefined ? true : raw.enabled,
    days: asDays(raw.days, []),
    time: formatClock(t),
    action,
  };
}

const NOTIFY_EVENTS: NotifyEvent[] = [
  "plug",
  "unplug",
  "officeTopupStart",
  "officeTopupDone",
  "heatPause",
  "calibrationStep",
  "dischargeDone",
];
const MENUBAR_ICONS: MenubarIcon[] = ["battery", "percent", "bolt", "leaf"];
const MENUBAR_SECTIONS: MenubarSection[] = [
  "status",
  "place",
  "limit",
  "actions",
  "officeHours",
  "schedule",
  "settings",
];
const WIDGET_CORNERS: WidgetCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const WIDGET_THEMES: WidgetTheme[] = ["auto", "dark", "light", "glass", "graphite", "midnight", "sand", "contrast"];
const PLACE_MODES: PlaceMode[] = ["auto", "home", "office", "away"];
/** Scale in percent for the old widget.size values. */
const LEGACY_WIDGET_SCALE: Record<string, number> = { small: 85, medium: 100, large: 115, xlarge: 130 };

/** Round the widget scale to the nearest 5 and clamp it to 70..150. Map the old widget.size if there is no scale. */
function asWidgetScale(wg: Record<string, unknown>, def: number): number {
  if (typeof wg.scale === "number" && Number.isFinite(wg.scale)) {
    return Math.min(150, Math.max(70, Math.round(wg.scale / 5) * 5));
  }
  if (typeof wg.size === "string" && Object.hasOwn(LEGACY_WIDGET_SCALE, wg.size)) return LEGACY_WIDGET_SCALE[wg.size]!;
  return def;
}

/**
 * Merge raw over DEFAULT_CONFIG and clamp every value.
 * Bad values change to defaults. Throws only if raw is not an object and not undefined.
 */
export function validateConfig(raw: unknown): Config {
  if (raw === undefined) return clone(DEFAULT_CONFIG);
  if (!isObj(raw)) throw new TypeError("Config must be an object.");
  const d = DEFAULT_CONFIG;

  const places = isObj(raw.places) ? raw.places : {};
  const oh = isObj(raw.officeHours) ? raw.officeHours : {};
  const heat = isObj(raw.heat) ? raw.heat : {};
  const lp = isObj(raw.lowPower) ? raw.lowPower : {};
  const mb = isObj(raw.menubar) ? raw.menubar : {};
  const wg = isObj(raw.widget) ? raw.widget : {};
  const notes = isObj(raw.notifications) ? raw.notifications : {};

  const maxC = clampNum(heat.maxC, d.heat.maxC, 25, 50);
  let resumeC = clampNum(heat.resumeC, d.heat.resumeC, 10, 50);
  if (resumeC >= maxC) resumeC = maxC - 3;

  const notifications: Partial<Record<NotifyEvent, boolean>> = {};
  for (const ev of NOTIFY_EVENTS) {
    const v = notes[ev];
    if (typeof v === "boolean") notifications[ev] = v;
  }

  const schedule: ScheduleRule[] = [];
  if (Array.isArray(raw.schedule)) {
    for (const item of raw.schedule) {
      const rule = asScheduleRule(item);
      if (rule && !schedule.some((r) => r.id === rule.id)) schedule.push(rule);
    }
  }

  let sections: MenubarSection[] = [...d.menubar.sections];
  if (Array.isArray(mb.sections)) {
    sections = [];
    for (const s of mb.sections) {
      if (MENUBAR_SECTIONS.includes(s as MenubarSection) && !sections.includes(s as MenubarSection)) {
        sections.push(s as MenubarSection);
      }
    }
  }

  const lastCal =
    typeof raw.lastCalibration === "string" && !Number.isNaN(Date.parse(raw.lastCalibration))
      ? raw.lastCalibration
      : null;

  return {
    version: 1,
    limit: clampNum(raw.limit, d.limit, 10, 100),
    sail: clampNum(raw.sail, d.sail, 0, 20),
    awayLimit: clampNum(raw.awayLimit, d.awayLimit, 10, 100),
    places: {
      home: asPlace(places.home, d.places.home),
      office: asPlace(places.office, d.places.office),
    },
    placeMode: PLACE_MODES.includes(raw.placeMode as PlaceMode) ? (raw.placeMode as PlaceMode) : d.placeMode,
    officeHours: {
      enabled: asBool(oh.enabled, d.officeHours.enabled),
      days: asDays(oh.days, d.officeHours.days),
      start: asClock(oh.start, d.officeHours.start),
      end: asClock(oh.end, d.officeHours.end),
      leadMin: clampNum(oh.leadMin, d.officeHours.leadMin, 0, 240),
      graceMin: clampNum(oh.graceMin, d.officeHours.graceMin, 0, 480),
    },
    heat: { enabled: asBool(heat.enabled, d.heat.enabled), maxC, resumeC },
    autoDischarge: asBool(raw.autoDischarge, d.autoDischarge),
    dischargeInClamshell: asBool(raw.dischargeInClamshell, d.dischargeInClamshell),
    stopChargingWhenSleeping: asBool(raw.stopChargingWhenSleeping, d.stopChargingWhenSleeping),
    sleepControl: asBool(raw.sleepControl, d.sleepControl),
    lowPower: {
      enabled: asBool(lp.enabled, d.lowPower.enabled),
      belowPct: clampNum(lp.belowPct, d.lowPower.belowPct, 5, 50),
    },
    magsafeLed: asBool(raw.magsafeLed, d.magsafeLed),
    schedule,
    notifications,
    menubar: {
      icon: MENUBAR_ICONS.includes(mb.icon as MenubarIcon) ? (mb.icon as MenubarIcon) : d.menubar.icon,
      showPercent: asBool(mb.showPercent, d.menubar.showPercent),
      sections,
    },
    widget: {
      corner: WIDGET_CORNERS.includes(wg.corner as WidgetCorner) ? (wg.corner as WidgetCorner) : d.widget.corner,
      theme: WIDGET_THEMES.includes(wg.theme as WidgetTheme) ? (wg.theme as WidgetTheme) : d.widget.theme,
      scale: asWidgetScale(wg, d.widget.scale),
      panelHeight: clampNum(wg.panelHeight, d.widget.panelHeight, 40, 100),
    },
    lastCalibration: lastCal,
  };
}

const OVERRIDE_KINDS: OverrideKind[] = ["topup", "discharge", "calibrate", "pause"];
const CAL_STEPS: CalibrationStep[] = ["drain", "fill", "hold", "settle"];
const PLACE_KINDS: PlaceKind[] = ["home", "office", "away", "offline"];

function asOverride(raw: unknown): Override | null {
  if (!isObj(raw)) return null;
  if (!OVERRIDE_KINDS.includes(raw.kind as OverrideKind)) return null;
  if (typeof raw.startedAt !== "string") return null;
  const target = typeof raw.target === "number" && Number.isFinite(raw.target) ? clampNum(raw.target, 100, 10, 100) : null;
  const step = CAL_STEPS.includes(raw.step as CalibrationStep) ? (raw.step as CalibrationStep) : null;
  return {
    kind: raw.kind as OverrideKind,
    target,
    step,
    startedAt: raw.startedAt,
    stepStartedAt: typeof raw.stepStartedAt === "string" ? raw.stepStartedAt : null,
    source: raw.source === "schedule" ? "schedule" : "user",
  };
}

/** Merge raw over DEFAULT_STATE. Throws only if raw is not an object and not undefined. */
export function validateState(raw: unknown): RuntimeState {
  if (raw === undefined) return clone(DEFAULT_STATE);
  if (!isObj(raw)) throw new TypeError("State must be an object.");
  const d = DEFAULT_STATE;
  const fails = typeof raw.sensorFailures === "number" && Number.isFinite(raw.sensorFailures) ? raw.sensorFailures : 0;
  return {
    override: asOverride(raw.override),
    sailing: asBool(raw.sailing, d.sailing),
    heatBlocked: asBool(raw.heatBlocked, d.heatBlocked),
    lastAc: typeof raw.lastAc === "boolean" ? raw.lastAc : null,
    lastPlace: PLACE_KINDS.includes(raw.lastPlace as PlaceKind) ? (raw.lastPlace as PlaceKind) : null,
    lastPlugAt: typeof raw.lastPlugAt === "string" ? raw.lastPlugAt : null,
    lastUnplugAt: typeof raw.lastUnplugAt === "string" ? raw.lastUnplugAt : null,
    sensorFailures: Math.max(0, Math.floor(fails)),
    firedRules: Array.isArray(raw.firedRules) ? raw.firedRules.filter((x): x is string => typeof x === "string") : [],
    officeTopupNotified: typeof raw.officeTopupNotified === "string" ? raw.officeTopupNotified : null,
  };
}

// ---------------------------------------------------------------------------
// File storage
// ---------------------------------------------------------------------------

export function configDir(home: string = os.homedir()): string {
  return path.join(home, PATHS.dirName);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readJson<T>(file: string, validate: (raw: unknown) => T, fallback: () => T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return fallback();
  }
  try {
    return validate(JSON.parse(text));
  } catch {
    try {
      fs.copyFileSync(file, file + ".bad");
    } catch {
      // The copy is a help only. Ignore a failed copy.
    }
    return fallback();
  }
}

function writeJsonAtomic(dir: string, name: string, value: unknown): void {
  ensureDir(dir);
  const file = path.join(dir, name);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // No temporary file to remove.
    }
    throw err;
  }
}

export function loadConfig(dir: string): Config {
  return readJson(path.join(dir, PATHS.config), validateConfig, () => clone(DEFAULT_CONFIG));
}

export function saveConfig(dir: string, cfg: Config): void {
  writeJsonAtomic(dir, PATHS.config, cfg);
}

export function loadState(dir: string): RuntimeState {
  return readJson(path.join(dir, PATHS.state), validateState, () => clone(DEFAULT_STATE));
}

export function saveState(dir: string, st: RuntimeState): void {
  writeJsonAtomic(dir, PATHS.state, st);
}
