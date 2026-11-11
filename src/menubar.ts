// SwiftBar output. renderMenubar is pure: it takes a Status and a time, and returns text.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mode, MenubarSection, ScheduleRule, Status } from "./types";

const STALE_MS = 90_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const MODE_COLOR: Partial<Record<Mode, string>> = {
  holding: "#30D158",
  charging: "#FFD60A",
  topup: "#0A84FF",
  discharging: "#64D2FF",
  calibrating: "#64D2FF",
  heat: "#FF453A",
  error: "#FF453A",
};

export function cgPath(): string {
  return join(homedir(), ".chargeguard", "bin", "cg");
}

export function isStale(status: Status, now: Date): boolean {
  const t = Date.parse(status.updatedAt);
  return !Number.isFinite(t) || now.getTime() - t > STALE_MS;
}

/** SF symbol name for a battery percent. */
export function batterySymbol(pct: number, charging: boolean): string {
  const level = pct >= 88 ? 100 : pct >= 63 ? 75 : pct >= 38 ? 50 : pct >= 13 ? 25 : 0;
  return charging && level === 100 ? "battery.100.bolt" : `battery.${level}`;
}

function action(label: string, args: string[], extra = ""): string {
  const params = args.map((a, i) => `param${i + 1}=${a}`).join(" ");
  return `${label} | bash=${cgPath()} ${params} terminal=false refresh=true${extra ? " " + extra : ""}`;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function days(list: number[]): string {
  return list.map((d) => DAY_NAMES[d] ?? "?").join(", ");
}

function actionText(r: ScheduleRule): string {
  const a = r.action;
  return a.kind === "limit" || a.kind === "discharge" ? `${a.kind} ${a.value}` : a.kind;
}

function notRunning(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return [
    "⚠ | sfimage=exclamationmark.triangle sfcolor=#FF453A",
    "---",
    "ChargeGuard is not running",
    `Start the daemon | bash=/bin/launchctl param1=kickstart param2=-k param3=gui/${uid}/com.chargeguard.daemon terminal=false refresh=true`,
  ].join("\n");
}

function headerLine(s: Status): string {
  const cfg = s.config;
  const pct = s.snapshot.percent;
  const pctText = Number.isFinite(pct) ? `${Math.round(pct)}%` : "?";
  const color = MODE_COLOR[s.decision.mode];
  const colorParam = color ? ` sfcolor=${color}` : "";
  switch (cfg.menubar.icon) {
    case "percent":
      return `${pctText} |${color ? ` color=${color}` : ""}`.trimEnd();
    case "bolt":
      return `${cfg.menubar.showPercent ? pctText + " " : ""}| sfimage=bolt.fill${colorParam}`;
    case "leaf":
      return `${cfg.menubar.showPercent ? pctText + " " : ""}| sfimage=leaf.fill${colorParam}`;
    case "battery":
    default: {
      const sym = batterySymbol(Number.isFinite(pct) ? pct : 0, s.snapshot.charging);
      return `${cfg.menubar.showPercent ? pctText + " " : ""}| sfimage=${sym}${colorParam}`;
    }
  }
}

function sectionStatus(s: Status): string[] {
  const snap = s.snapshot;
  const lines = [`${s.decision.summary} | disabled=true`];
  const state = snap.ac ? (snap.charging ? "charging" : "on AC") : "on battery";
  lines.push(`Battery ${Math.round(snap.percent)}%, ${state}, mode ${s.decision.mode} | disabled=true`);
  if (snap.tempC !== null) lines.push(`Temperature ${snap.tempC.toFixed(1)} °C | disabled=true`);
  if (snap.adapterWatts !== null) lines.push(`Charger ${snap.adapterWatts} W | disabled=true`);
  if (snap.healthPct !== null) {
    const cycles = snap.cycleCount !== null ? `, ${snap.cycleCount} cycles` : "";
    lines.push(`Health ${snap.healthPct}%${cycles} | disabled=true`);
  }
  if (s.health.lastError) lines.push(`Error: ${s.health.lastError} | color=#FF453A disabled=true`);
  return lines;
}

function sectionPlace(s: Status): string[] {
  const lines = [`Place: ${s.placeLabel} | disabled=true`];
  if (s.snapshot.routerMac) lines.push(`Router ${s.snapshot.routerMac} | disabled=true`);
  lines.push(action(`Save current Wi-Fi as ${s.config.places.home.label}`, ["place", "save", "home"]));
  lines.push(action(`Save current Wi-Fi as ${s.config.places.office.label}`, ["place", "save", "office"]));
  return lines;
}

function sectionLimit(s: Status): string[] {
  const lines = ["Charge limit | disabled=true"];
  for (const v of [80, 90, 100]) {
    const on = s.config.limit === v;
    lines.push(action(`${v}%`, ["limit", String(v)], on ? "checked=true" : ""));
  }
  return lines;
}

function sectionActions(s: Status): string[] {
  const o = s.state.override;
  const lines: string[] = [];
  lines.push(o?.kind === "topup" ? action("Stop top-up", ["topup", "stop"]) : action("Top up to 100%", ["topup"]));
  lines.push(
    o?.kind === "discharge"
      ? action("Stop discharge", ["discharge", "stop"])
      : action(`Discharge to ${s.config.limit}%`, ["discharge", String(s.config.limit)]),
  );
  lines.push(o?.kind === "pause" ? action("Resume", ["resume"]) : action("Pause", ["pause"]));
  lines.push(o?.kind === "calibrate" ? action("Stop calibration", ["calibrate", "stop"]) : action("Calibrate", ["calibrate"]));
  return lines;
}

function sectionOffice(s: Status): string[] {
  const oh = s.config.officeHours;
  const lines = [`Office hours ${oh.enabled ? "on" : "off"}: ${oh.start} to ${oh.end} | disabled=true`];
  if (oh.enabled) {
    lines.push(`Days: ${days(oh.days)} | disabled=true`);
    if (s.office.topupStart) lines.push(`Top-up starts ${fmtClock(s.office.topupStart)} | disabled=true`);
  }
  if (s.next) lines.push(`${s.next} | disabled=true`);
  lines.push(
    oh.enabled ? action("Turn office hours off", ["office-hours", "off"]) : action("Turn office hours on", ["office-hours", "on"]),
  );
  return lines;
}

function sectionSchedule(s: Status): string[] {
  const rules = s.config.schedule;
  const lines = ["Schedule | disabled=true"];
  if (rules.length === 0) lines.push("No rules | disabled=true");
  for (const r of rules) {
    lines.push(`${r.enabled ? "" : "(off) "}${days(r.days)} ${r.time} ${actionText(r)} | disabled=true`);
  }
  return lines;
}

function sectionSettings(): string[] {
  const dir = join(homedir(), ".chargeguard");
  return [
    `Open config in editor | bash=/usr/bin/open param1=-t param2=${join(dir, "config.json")} terminal=false`,
    `Run doctor in Terminal | bash=${cgPath()} param1=doctor terminal=true`,
    `Open log | bash=/usr/bin/open param1=-t param2=${join(dir, "chargeguard.log")} terminal=false`,
  ];
}

/** Build the full SwiftBar text. status null or older than 90 s shows the warning. */
export function renderMenubar(status: Status | null, now: Date): string {
  if (!status || isStale(status, now)) return notRunning();
  const out: string[] = [headerLine(status), "---"];
  const builders: Record<MenubarSection, () => string[]> = {
    status: () => sectionStatus(status),
    place: () => sectionPlace(status),
    limit: () => sectionLimit(status),
    actions: () => sectionActions(status),
    officeHours: () => sectionOffice(status),
    schedule: () => sectionSchedule(status),
    settings: () => sectionSettings(),
  };
  status.config.menubar.sections.forEach((name, i) => {
    const b = builders[name];
    if (!b) return;
    if (i > 0) out.push("---");
    out.push(...b());
  });
  return out.join("\n");
}
