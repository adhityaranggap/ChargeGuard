// ChargeGuard shared contract. Owned by the planner (Opus).
// Workers must not change these types. Ask the planner first if a change is necessary.
// Spec: docs/PRD.md (requirement IDs R1..R22) and docs/DESIGN.md.

export type PlaceId = "home" | "office";
export type PlaceKind = PlaceId | "away" | "offline";
/** How the daemon finds the place. "auto" uses the router. The other values set the place by hand. */
export type PlaceMode = "auto" | "home" | "office" | "away";

/** 0 = Sunday ... 6 = Saturday (same as Date.getDay()). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** "HH:MM", 24 h, local time. */
export type ClockTime = string;

export interface Place {
  label: string;
  /** Router MACs of the default gateway, normalized lowercase "aa:bb:cc:dd:ee:ff". */
  routers: string[];
  /** Per-place limit. null = use Config.limit. */
  limit: number | null;
  /** Street address for the travel time estimate. null = no address. Maximum 200 characters. */
  address: string | null;
}

export interface OfficeHours {
  enabled: boolean;
  days: Weekday[];
  start: ClockTime;
  end: ClockTime;
  /** Top-up to 100% starts at end - leadMin. */
  leadMin: number;
  /** Target stays 100% until end + graceMin, then returns to the limit. */
  graceMin: number;
}

export type ScheduleAction =
  | { kind: "topup" }
  | { kind: "calibrate" }
  | { kind: "limit"; value: number }
  | { kind: "discharge"; value: number };

export interface ScheduleRule {
  id: string;
  enabled: boolean;
  days: Weekday[];
  time: ClockTime;
  action: ScheduleAction;
}

export type MenubarIcon = "battery" | "percent" | "bolt" | "leaf";
export type MenubarSection = "status" | "place" | "limit" | "actions" | "officeHours" | "schedule" | "settings";
export type WidgetCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type WidgetTheme = "auto" | "dark" | "light" | "glass" | "graphite" | "midnight" | "sand" | "contrast";

export type NotifyEvent =
  | "plug"
  | "unplug"
  | "officeTopupStart"
  | "officeTopupDone"
  | "heatPause"
  | "calibrationStep"
  | "dischargeDone"
  | "tripTopupStart";

export interface Config {
  version: 1;
  /** R1. Default target at Home and Office. 50..100. Default 80. */
  limit: number;
  /** R6. Sailing gap in percent. 0..20. Default 5. */
  sail: number;
  /** R2. Target on unknown networks. Default 100. */
  awayLimit: number;
  places: Record<PlaceId, Place>;
  /**
   * Place mode. "auto" finds the place from the router MAC.
   * "home", "office", or "away" sets the place by hand and ignores the router, also with no network.
   * Default "auto".
   */
  placeMode: PlaceMode;
  /** R4. */
  officeHours: OfficeHours;
  /** Calendar trips. Charge to 100% before you leave for a meeting at another place. Default off. */
  calendar: {
    enabled: boolean;
    /** Minutes to arrive before the meeting starts. 0..120. Default 10. */
    arriveBufferMin: number;
    /** Travel time in minutes when no estimate exists. 0..300. Default 45. */
    fallbackTravelMin: number;
    /** The top-up stays on until leave time plus this many minutes. 0..240. Default 30. */
    graceMin: number;
    /** Only meetings that start inside this many hours count. 1..72. Default 24. */
    lookaheadH: number;
    /** A trip with a known travel time below this many minutes is too near. It starts no top-up. 0..120. Default 10. */
    minTravelMin: number;
  };
  /** R8. */
  heat: { enabled: boolean; maxC: number; resumeC: number };
  /** R11. Default false. */
  autoDischarge: boolean;
  /** R12. Default false. */
  dischargeInClamshell: boolean;
  /** R17. Default true. */
  stopChargingWhenSleeping: boolean;
  /** R16. Default true. */
  sleepControl: boolean;
  /** R18. */
  lowPower: { enabled: boolean; belowPct: number };
  /** R13. Default true. */
  magsafeLed: boolean;
  /** R15. */
  schedule: ScheduleRule[];
  /** R5. Per event on/off. Missing key = on. */
  notifications: Partial<Record<NotifyEvent, boolean>>;
  /** R20. */
  menubar: { icon: MenubarIcon; showPercent: boolean; sections: MenubarSection[] };
  /** Desktop widget settings. */
  widget: {
    /** Widget position. Default "bottom-left". */
    corner: WidgetCorner;
    /** Color theme. "auto" follows the system appearance. Default "auto". */
    theme: WidgetTheme;
    /** Widget scale in percent. Range 70..150, in steps of 5. Default 100. */
    scale: number;
    /** Maximum height of the widget with the settings panel open, in percent of the screen height. Range 40..100. Default 85. */
    panelHeight: number;
  };
  /** R14. ISO date of the last finished calibration, or null. */
  lastCalibration: string | null;
}

/** One reading of the hardware. Produced by sensors.ts + net.ts. */
export interface Snapshot {
  /** 0..100 as macOS shows it. */
  percent: number;
  /** Charger connected. */
  ac: boolean;
  /** Battery is charging now. */
  charging: boolean;
  /** Battery temperature in °C. null = not available. */
  tempC: number | null;
  /** Lid closed. */
  clamshell: boolean;
  /** Router MAC of the default gateway. null = no network. */
  routerMac: string | null;
  gatewayIp: string | null;
  /** Charger watts. null = no charger. */
  adapterWatts: number | null;
  /** Battery health "Maximum Capacity" percent. */
  healthPct: number | null;
  cycleCount: number | null;
  /** Minutes to empty from macOS, null if unknown. */
  minutesToEmpty: number | null;
  /** Minutes to full from macOS, null if unknown. */
  minutesToFull: number | null;
  /** Battery power in watts. Positive = charging, negative = discharging. null if unknown. */
  batteryWatts: number | null;
  /** True only inside the sleep hook. */
  sleeping: boolean;
}

export type OverrideKind = "topup" | "discharge" | "calibrate" | "pause";

/** Calibration steps for R14, in order. */
export type CalibrationStep = "drain" | "fill" | "hold" | "settle";

export interface Override {
  kind: OverrideKind;
  /** Target percent for topup (100) and discharge (N). Unused for pause. */
  target: number | null;
  /** Only for calibrate. */
  step: CalibrationStep | null;
  /** ISO time. */
  startedAt: string;
  /** ISO time when the current calibration step started (for "hold" 60 min). */
  stepStartedAt: string | null;
  /** Origin of the override. */
  source: "user" | "schedule";
}

/** Persisted between ticks in ~/.chargeguard/state.json. Owned by policy.decide(). */
export interface RuntimeState {
  override: Override | null;
  /** R6. True after the target was reached; charging waits until percent <= target - sail. */
  sailing: boolean;
  /** R8. True while heat protection blocks charging. */
  heatBlocked: boolean;
  lastAc: boolean | null;
  lastPlace: PlaceKind | null;
  /** ISO time of the last plug-in. The widget shows the banner for 20 s after it. */
  lastPlugAt: string | null;
  /** ISO time of the last unplug. The widget shows the unplug banner for 10 s after it. */
  lastUnplugAt: string | null;
  /** Count of consecutive failed sensor reads (R9). */
  sensorFailures: number;
  /** Schedule rule ids that already fired today, as "<id>@YYYY-MM-DD". */
  firedRules: string[];
  /** True while office top-up was announced for today, as "YYYY-MM-DD", to notify only once. */
  officeTopupNotified: string | null;
  /** Latch for the trip top-up. It stays set until `until` (ISO), or until the trip leaves the list. */
  tripTopup: { id: string; until: string } | null;
  /** Id of the trip for which the top-up text was sent, to notify only once. */
  tripTopupNotified: string | null;
  /** Smoothed charge power in watts from earlier ticks, or null. The ETA uses it while the battery holds and the live power is 0. */
  lastChargeWatts: number | null;
}

export type Mode =
  | "holding" // at target, charging off, adapter on
  | "charging" // charging toward target
  | "sailing" // below target but inside sail gap, charging off
  | "topup" // charging to 100 by override or office hours
  | "discharging" // adapter off
  | "calibrating"
  | "heat" // charging blocked by heat
  | "paused" // management off, macOS default behavior
  | "unplugged" // on battery
  | "error"; // fail-safe active

export type Led = "system" | "off" | "green" | "orange";

export interface NotifyMessage {
  event: NotifyEvent;
  title: string;
  body: string;
}

/** Output of policy.decide(). The daemon applies it to the hardware. */
export interface Decision {
  /**
   * Native macOS charge limit to apply (10..100). 100 = no limit.
   * Normally equals target. During heat protection it is the current percent.
   * The daemon writes it through `cg-helper limit N` only when it changes.
   */
  nativeLimit: number;
  /** Use the charger (false = discharge on AC). Never false when percent < 10 (R9). */
  adapter: boolean;
  led: Led;
  /** null = do not change Low Power Mode. */
  lowPower: boolean | null;
  /** R16. Hold an idle-sleep assertion. */
  preventSleep: boolean;
  /** Effective target percent now. */
  target: number;
  place: PlaceKind;
  mode: Mode;
  /** Short machine reason, for example "limit", "office-topup", "heat", "sail", "away", "override-topup". */
  reason: string;
  /** One human sentence for the UI, for example "Stops at 80%. Starts again at 75%." */
  summary: string;
  /** Notifications to send this tick. */
  notify: NotifyMessage[];
}

export interface DecideResult {
  decision: Decision;
  state: RuntimeState;
}

/** Signature that src/policy.ts must export. Pure: no I/O, no Date.now(). */
export type DecideFn = (
  snap: Snapshot,
  cfg: Config,
  state: RuntimeState,
  now: Date,
  ctx?: { trips: Trip[] },
) => DecideResult;

/** One calendar meeting with a physical place. The calendar probe writes the list to ~/.chargeguard/trips.json. */
export interface Trip {
  id: string;
  title: string;
  /** ISO time. */
  start: string;
  location: string;
  /** Drive time in minutes from the probe. null = no estimate. */
  travelMin: number | null;
  /** Place where the probe started the estimate. */
  from: PlaceKind;
}

/** Times for the next trip. All times are ISO strings. */
export interface TripWindow {
  id: string;
  title: string;
  location: string;
  start: string;
  leaveAt: string;
  topupStart: string;
  /** Travel time in minutes that the policy uses, after the fallback. */
  travelMin: number;
  /** True when the fallback travel time was used. */
  travelEstimated: boolean;
  /** Minutes of charge time, with the 1.2 margin. */
  chargeMin: number;
  /** True when the top-up start is past and the battery cannot reach 100% before leaveAt. */
  tooLate: boolean;
}

export interface OfficeWindow {
  /** ISO times for today. null when office hours do not apply today. */
  topupStart: string | null;
  end: string | null;
  graceEnd: string | null;
  /** Estimated minutes to reach 100% from the current percent with the current charger. null if unknown. */
  etaMin: number | null;
  /** True if the ETA is longer than leadMin (slow charger warning). */
  tooSlow: boolean;
}

export interface Health {
  daemon: boolean;
  /** smc binary found at /usr/local/libexec/chargeguard/smc. */
  smc: boolean;
  /** Charge limit backend. "native" = macOS 27 PowerUIAgent limit (see PRD "Charge control backend"). */
  backend: "native" | "none";
  /** Native limit that macOS reports now (pmset -g battlimit, chargeSocLimitSoc). null = no limit set. */
  appliedLimit: number | null;
  /** cg-helper installed and sudo -n works. */
  helper: boolean;
  /** Battery temperature source key, for example "TB0T". null if none. */
  tempKey: string | null;
  /** Human text of the last error, or null. */
  lastError: string | null;
}

/** Written by the daemon to ~/.chargeguard/status.json every tick. Read by the widget, menu bar, and CLI. */
export interface Status {
  version: 1;
  /** ISO time. The UI shows "stale" if older than 90 s. */
  updatedAt: string;
  snapshot: Snapshot;
  decision: Decision;
  state: RuntimeState;
  /** Copy of the active config, so the UI needs only one file. */
  config: Config;
  /** Which saved place matches the current router, and label. */
  placeLabel: string;
  office: OfficeWindow;
  /** One human line about the next change, or null. Example: "Top-up starts 15:30. Full by about 17:00." */
  next: string | null;
  /** Next calendar trip, or null. */
  trip: TripWindow | null;
  health: Health;
}

/** Paths. All under ~/.chargeguard. */
export const PATHS = {
  dirName: ".chargeguard",
  config: "config.json",
  state: "state.json",
  status: "status.json",
  trips: "trips.json",
  kick: "kick",
  log: "chargeguard.log",
} as const;
