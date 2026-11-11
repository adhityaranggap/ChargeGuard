// ChargeGuard command line. Run: bun src/cli.ts <command>
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDaemon } from "./daemon";
import {
  DEFAULT_CONFIG, configDir, formatClock, loadConfig, normalizeMac, parseClock, saveConfig, validateConfig,
} from "./config";
import { HELPER_PATH, helperAvailable, readAppliedLimit, setAdapter } from "./helper";
import { renderMenubar } from "./menubar";
import { readRouter } from "./net";
import { SMC_PATH, runCmd } from "./smc";
import { PATHS } from "./types";
import type { Config, NotifyEvent, PlaceId, PlaceMode, ScheduleAction, ScheduleRule, Status, Weekday } from "./types";

const BUN_PATH = "/Users/rangga-sa/.bun/bin/bun";
const STALE_SEC = 90;
const NOTIFY_EVENTS: NotifyEvent[] = [
  "plug", "unplug", "officeTopupStart", "officeTopupDone", "heatPause", "calibrationStep", "dischargeDone",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

class CliError extends Error {}

interface Args {
  pos: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `ChargeGuard. Battery charge manager.

Usage: cg <command> [options]

Show
  status [--json]            Show the state now.
  doctor [--json]            Check the install.
  menubar                    Print SwiftBar text.

Settings
  limit <10..100>            Set the charge limit in percent.
  set <key> <value>          Change one setting. Keys:
                             sail, awayLimit, heat.enabled, heat.maxC, heat.resumeC,
                             autoDischarge, dischargeInClamshell, stopChargingWhenSleeping,
                             sleepControl, lowPower.enabled, lowPower.belowPct, magsafeLed,
                             menubar.icon, menubar.showPercent, widget.corner,
                             widget.theme, widget.scale, widget.panelHeight,
                             placeMode, notifications.<event>
  place save home|office [--router <mac>]
  place forget home|office [--router <mac>]
  place list
  place use auto|home|office|away
                             Set the place by hand. "auto" uses the router again.
  office-hours on|off
  office-hours set [--start HH:MM] [--end HH:MM] [--lead N] [--grace N] [--days 1,2,3,4,5]
  schedule list
  schedule add --days 1,2 --time HH:MM --action topup|calibrate|limit:N|discharge:N
  schedule rm <id>

Actions
  topup [stop]               Charge to 100 percent once.
  discharge <N>|stop         Use the battery on AC down to N percent.
  calibrate [stop]           Start or stop a calibration.
  pause | resume             Stop or start management.

System
  init                       Write the default config if it is missing.
  daemon                     Run the daemon in the foreground.
  hook sleep|wake            Called by sleepwatcher.
  help                       Show this text.

Add --json to status and doctor for JSON output.
`;

function dir(): string {
  return configDir();
}

function readStatus(): { status: Status | null; ageSec: number | null } {
  const p = join(dir(), PATHS.status);
  try {
    const status = JSON.parse(readFileSync(p, "utf8")) as Status;
    const ageSec = Math.round((Date.now() - statSync(p).mtimeMs) / 1000);
    return { status, ageSec };
  } catch {
    return { status: null, ageSec: null };
  }
}

function touchKick(): void {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), PATHS.kick), String(Date.now()));
}

function warnIfStopped(): void {
  const { ageSec } = readStatus();
  if (ageSec === null || ageSec > STALE_SEC) {
    console.error("The daemon is not running. Run: launchctl kickstart -k gui/$(id -u)/com.chargeguard.daemon");
  }
}

function editConfig(fn: (c: Config) => void): Config {
  let c: Config;
  try { c = loadConfig(dir()); } catch { c = structuredClone(DEFAULT_CONFIG); }
  fn(c);
  let v: Config;
  try {
    v = validateConfig(c);
  } catch (e) {
    throw new CliError(`The value is not valid. ${e instanceof Error ? e.message : e}`);
  }
  mkdirSync(dir(), { recursive: true });
  saveConfig(dir(), v);
  touchKick();
  warnIfStopped();
  return v;
}

function sendCommand(cmd: Record<string, unknown>): void {
  mkdirSync(dir(), { recursive: true });
  appendFileSync(join(dir(), "inbox.jsonl"), JSON.stringify({ ...cmd, at: new Date().toISOString() }) + "\n");
  touchKick();
  warnIfStopped();
}

function emit(json: boolean, obj: unknown, text: string): void {
  console.log(json ? JSON.stringify(obj, null, 2) : text);
}

function parseNum(s: string | undefined, what: string, lo: number, hi: number): number {
  const n = Number(s);
  if (s === undefined || s === "" || !Number.isFinite(n) || n < lo || n > hi) {
    throw new CliError(`${what} must be a number from ${lo} to ${hi}.`);
  }
  return Math.round(n);
}

function parseDays(s: string | true | undefined): Weekday[] {
  if (typeof s !== "string") throw new CliError("Give the days with --days, for example --days 1,2,3.");
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new CliError("A day must be 0 (Sunday) to 6 (Saturday).");
    out.add(n);
  }
  return [...out].sort() as Weekday[];
}

function dayText(d: number[]): string {
  return d.map((x) => DAY_NAMES[x] ?? "?").join(",");
}

function parsePlaceId(s: string | undefined): PlaceId {
  if (s === "home" || s === "office") return s;
  throw new CliError("The place must be home or office.");
}

// ---- status ----

function cmdStatus(json: boolean): number {
  const { status, ageSec } = readStatus();
  if (!status) {
    emit(json, { error: "no-status", stale: true }, "No status yet. The daemon is not running.\nRun: launchctl kickstart -k gui/$(id -u)/com.chargeguard.daemon");
    return 1;
  }
  const stale = ageSec === null || ageSec > STALE_SEC;
  if (json) {
    console.log(JSON.stringify({ ...status, stale, ageSec }, null, 2));
    return 0;
  }
  const s = status.snapshot;
  const d = status.decision;
  const lines = [
    `place=${d.place} target=${d.target} mode=${d.mode} reason=${d.reason}`,
    d.summary,
    `Place: ${status.placeLabel}${(status.config.placeMode ?? "auto") !== "auto" ? " (manual)" : ""}`,
    `Battery: ${Math.round(s.percent)}%, ${s.ac ? (s.charging ? "AC, charging" : "AC, not charging") : "on battery"}`,
    `Native limit: ${d.nativeLimit}%. macOS reports: ${status.health.appliedLimit ?? "none"}.`,
  ];
  if (s.tempC !== null) lines.push(`Temperature: ${s.tempC.toFixed(1)} C`);
  if (s.adapterWatts !== null) lines.push(`Charger: ${s.adapterWatts} W`);
  if (s.healthPct !== null) lines.push(`Health: ${s.healthPct}%, ${s.cycleCount ?? "?"} cycles`);
  if (s.batteryWatts !== null) lines.push(`Battery power: ${s.batteryWatts.toFixed(1)} W`);
  if (status.state.override) {
    const o = status.state.override;
    lines.push(`Override: ${o.kind}${o.target !== null ? " " + o.target : ""}${o.step ? " step " + o.step : ""}`);
  }
  if (status.next) lines.push(`Next: ${status.next}`);
  if (status.health.lastError) lines.push(`Error: ${status.health.lastError}`);
  if (stale) lines.push(`The status is ${ageSec}s old. The daemon is not running.\nRun: launchctl kickstart -k gui/$(id -u)/com.chargeguard.daemon`);
  console.log(lines.join("\n"));
  return 0;
}

// ---- doctor ----

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function cmdDoctor(json: boolean): number {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
  add("bun", existsSync(BUN_PATH), BUN_PATH);
  add("smc", existsSync(SMC_PATH), SMC_PATH);
  add("helper", existsSync(HELPER_PATH), HELPER_PATH);
  const sudoOk = helperAvailable();
  add("sudo rule", sudoOk, sudoOk ? "sudo -n works for cg-helper" : "Run: sudo bash scripts/install-root.sh");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const lc = runCmd(["/bin/launchctl", "print", `gui/${uid}/com.chargeguard.daemon`], 5000);
  const running = lc.ok && /state = running/.test(lc.out);
  add("daemon", running, running ? "running" : "not running");
  const { status, ageSec } = readStatus();
  const fresh = status !== null && ageSec !== null && ageSec <= STALE_SEC;
  add("status file", fresh, status === null ? "missing" : `${ageSec}s old`);
  const target = status ? status.decision.nativeLimit : null;
  const applied = readAppliedLimit();
  if (target !== null) {
    const okLimit = (applied ?? 100) === target;
    add("applied limit", okLimit, `macOS ${applied ?? "none"}, target ${target}`);
  } else add("applied limit", false, "no target yet");
  const router = readRouter();
  add("router", router.routerMac !== null, router.routerMac ?? "no network");
  let cfg: Config | null = null;
  try { cfg = loadConfig(dir()); } catch { /* reported below */ }
  add("office set", !!cfg && cfg.places.office.routers.length > 0, cfg ? `${cfg.places.office.routers.length} router(s)` : "no config");
  const allOk = checks.every((c) => c.ok);
  emit(json, { ok: allOk, checks }, checks.map((c) => `${c.ok ? "OK  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n"));
  return allOk ? 0 : 1;
}

// ---- config commands ----

function cmdLimit(v: string | undefined): void {
  const n = parseNum(v, "The limit", 10, 100);
  const c = editConfig((x) => { x.limit = n; });
  console.log(c.limit === n ? `Limit is ${n}%.` : `The limit is ${c.limit}%. Validation changed the value ${n}.`);
}

const PLACE_MODES: PlaceMode[] = ["auto", "home", "office", "away"];

function cmdPlace(args: string[], flags: Args["flags"]): void {
  const sub = args[0];
  if (sub === "list") {
    const c = loadConfig(dir());
    const lines = (["home", "office"] as PlaceId[]).map((id) => {
      const p = c.places[id];
      return `${id} (${p.label}): ${p.routers.length ? p.routers.join(", ") : "no router saved"}`;
    });
    console.log(lines.join("\n"));
    return;
  }
  if (sub === "use") {
    const mode = args[1];
    if (!PLACE_MODES.includes(mode as PlaceMode)) throw new CliError(`The place mode must be one of: ${PLACE_MODES.join(", ")}`);
    const c = editConfig((x) => { x.placeMode = mode as PlaceMode; });
    console.log(
      c.placeMode === "auto"
        ? "Place is automatic."
        : `Place set to ${c.placeMode} by hand. Run 'cg place use auto' to go back to automatic.`,
    );
    return;
  }
  if (sub !== "save" && sub !== "forget") throw new CliError("Use: place save|forget|list|use");
  const id = parsePlaceId(args[1]);
  const routerFlag = typeof flags.router === "string" ? flags.router : null;
  if (sub === "save") {
    let mac: string | null;
    if (routerFlag) mac = normalizeMac(routerFlag);
    else mac = readRouter().routerMac;
    if (!mac) throw new CliError(routerFlag ? "The MAC address is not valid." : "No router found. Connect to a network first.");
    const other: PlaceId = id === "home" ? "office" : "home";
    editConfig((c) => {
      if (!c.places[id].routers.includes(mac!)) c.places[id].routers.push(mac!);
      c.places[other].routers = c.places[other].routers.filter((m) => m !== mac);
    });
    console.log(`Saved router ${mac} for ${id}.`);
    return;
  }
  if (routerFlag) {
    const mac = normalizeMac(routerFlag);
    if (!mac) throw new CliError("The MAC address is not valid.");
    editConfig((c) => { c.places[id].routers = c.places[id].routers.filter((m) => m !== mac); });
    console.log(`Forgot router ${mac} for ${id}.`);
  } else {
    editConfig((c) => { c.places[id].routers = []; });
    console.log(`Forgot all routers for ${id}.`);
  }
}

function cmdOfficeHours(args: string[], flags: Args["flags"]): void {
  const sub = args[0];
  if (sub === "on" || sub === "off") {
    editConfig((c) => { c.officeHours.enabled = sub === "on"; });
    console.log(`Office hours are ${sub}.`);
    return;
  }
  if (sub !== "set") throw new CliError("Use: office-hours on|off|set");
  const clock = (v: string | true | undefined, what: string): string | null => {
    if (v === undefined) return null;
    const m = typeof v === "string" ? parseClock(v) : null;
    if (m === null) throw new CliError(`${what} must be HH:MM.`);
    return formatClock(m);
  };
  const start = clock(flags.start, "--start");
  const end = clock(flags.end, "--end");
  const lead = flags.lead !== undefined ? parseNum(String(flags.lead), "--lead", 0, 600) : null;
  const grace = flags.grace !== undefined ? parseNum(String(flags.grace), "--grace", 0, 600) : null;
  const days = flags.days !== undefined ? parseDays(flags.days) : null;
  const c = editConfig((x) => {
    if (start) x.officeHours.start = start;
    if (end) x.officeHours.end = end;
    if (lead !== null) x.officeHours.leadMin = lead;
    if (grace !== null) x.officeHours.graceMin = grace;
    if (days) x.officeHours.days = days;
  });
  const o = c.officeHours;
  console.log(`Office hours: ${o.start} to ${o.end}, days ${dayText(o.days)}, lead ${o.leadMin} min, grace ${o.graceMin} min.`);
}

type SetKind = "bool" | "num" | { enum: string[] };
const SET_KEYS: Record<string, SetKind> = {
  placeMode: { enum: ["auto", "home", "office", "away"] },
  sail: "num",
  awayLimit: "num",
  "heat.enabled": "bool",
  "heat.maxC": "num",
  "heat.resumeC": "num",
  autoDischarge: "bool",
  dischargeInClamshell: "bool",
  stopChargingWhenSleeping: "bool",
  sleepControl: "bool",
  "lowPower.enabled": "bool",
  "lowPower.belowPct": "num",
  magsafeLed: "bool",
  "menubar.icon": { enum: ["battery", "percent", "bolt", "leaf"] },
  "menubar.showPercent": "bool",
  "widget.corner": { enum: ["top-left", "top-right", "bottom-left", "bottom-right"] },
  "widget.theme": { enum: ["auto", "dark", "light", "glass", "graphite", "midnight", "sand", "contrast"] },
  "widget.scale": "num",
  "widget.panelHeight": "num",
};

function setPath(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts[parts.length - 1]!] = value;
}

function cmdSet(key: string | undefined, raw: string | undefined): void {
  if (!key || raw === undefined) throw new CliError("Use: set <key> <value>");
  let kind: SetKind | undefined = SET_KEYS[key];
  if (!kind && key.startsWith("notifications.")) {
    if (!NOTIFY_EVENTS.includes(key.slice("notifications.".length) as NotifyEvent)) {
      throw new CliError(`Unknown event. Events: ${NOTIFY_EVENTS.join(", ")}`);
    }
    kind = "bool";
  }
  if (!kind) throw new CliError(`This key is not allowed. Keys: ${[...Object.keys(SET_KEYS), "notifications.<event>"].join(", ")}`);
  let value: unknown;
  if (kind === "bool") {
    if (raw !== "true" && raw !== "false") throw new CliError("The value must be true or false.");
    value = raw === "true";
  } else if (kind === "num") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new CliError("The value must be a number.");
    value = n;
  } else {
    if (!kind.enum.includes(raw)) throw new CliError(`The value must be one of: ${kind.enum.join(", ")}`);
    value = raw;
  }
  editConfig((c) => setPath(c as unknown as Record<string, any>, key, value));
  console.log(`Set ${key} to ${raw}.`);
}

function parseAction(s: string | true | undefined): ScheduleAction {
  if (typeof s !== "string") throw new CliError("Give the action with --action: topup, calibrate, limit:N, or discharge:N.");
  if (s === "topup") return { kind: "topup" };
  if (s === "calibrate") return { kind: "calibrate" };
  const m = /^(limit|discharge):(\d+)$/.exec(s);
  if (m) return { kind: m[1] as "limit" | "discharge", value: parseNum(m[2], "The action value", 10, 100) };
  throw new CliError("The action must be topup, calibrate, limit:N, or discharge:N.");
}

function ruleText(r: ScheduleRule): string {
  const a = r.action;
  const act = a.kind === "limit" || a.kind === "discharge" ? `${a.kind}:${a.value}` : a.kind;
  return `${r.id}  ${r.enabled ? "on " : "off"}  ${dayText(r.days)}  ${r.time}  ${act}`;
}

function cmdSchedule(args: string[], flags: Args["flags"]): void {
  const sub = args[0];
  if (sub === "list") {
    const rules = loadConfig(dir()).schedule;
    console.log(rules.length ? rules.map(ruleText).join("\n") : "No schedule rules.");
    return;
  }
  if (sub === "add") {
    const days = parseDays(flags.days);
    const t = typeof flags.time === "string" ? parseClock(flags.time) : null;
    if (t === null) throw new CliError("Give the time with --time HH:MM.");
    const action = parseAction(flags.action);
    const id = "r" + Date.now().toString(36);
    editConfig((c) => { c.schedule.push({ id, enabled: true, days, time: formatClock(t), action }); });
    console.log(`Added rule ${id}.`);
    return;
  }
  if (sub === "rm") {
    const id = args[1];
    if (!id) throw new CliError("Use: schedule rm <id>");
    if (!loadConfig(dir()).schedule.some((r) => r.id === id)) throw new CliError(`No rule with id ${id}.`);
    editConfig((c) => { c.schedule = c.schedule.filter((r) => r.id !== id); });
    console.log(`Removed rule ${id}.`);
    return;
  }
  throw new CliError("Use: schedule list|add|rm");
}

// ---- hooks ----

function cmdHook(which: string | undefined): void {
  if (which === "sleep") {
    const { status } = readStatus();
    const k = status?.state.override?.kind;
    if (k === "discharge" || k === "calibrate") {
      const r = setAdapter(true);
      console.log(r.ok ? "The adapter is on before sleep." : `The adapter call failed. ${r.err}`);
    } else console.log("Nothing to do before sleep.");
    return;
  }
  if (which === "wake") {
    touchKick();
    console.log("The daemon will check the state now.");
    return;
  }
  throw new CliError("Use: hook sleep|wake");
}

function cmdInit(): void {
  mkdirSync(dir(), { recursive: true });
  const p = join(dir(), PATHS.config);
  if (existsSync(p)) {
    console.log(`The config exists: ${p}`);
    return;
  }
  saveConfig(dir(), validateConfig(structuredClone(DEFAULT_CONFIG)));
  console.log(`Wrote the default config: ${p}`);
}

// ---- main ----

async function main(): Promise<number> {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  const [cmd, ...rest] = pos;
  switch (cmd) {
    case "status": return cmdStatus(json);
    case "doctor": return cmdDoctor(json);
    case "limit": cmdLimit(rest[0]); return 0;
    case "place": cmdPlace(rest, flags); return 0;
    case "office-hours": cmdOfficeHours(rest, flags); return 0;
    case "set": cmdSet(rest[0], rest[1]); return 0;
    case "schedule": cmdSchedule(rest, flags); return 0;
    case "topup":
      if (rest[0] === "stop") { sendCommand({ op: "topup-stop" }); console.log("Top-up stops."); }
      else { sendCommand({ op: "topup" }); console.log("Top-up starts."); }
      return 0;
    case "discharge":
      if (rest[0] === "stop") { sendCommand({ op: "discharge-stop" }); console.log("Discharge stops."); }
      else {
        const n = parseNum(rest[0], "The target", 10, 99);
        sendCommand({ op: "discharge", target: n });
        console.log(`Discharge to ${n}% starts.`);
      }
      return 0;
    case "calibrate":
      if (rest[0] === "stop") { sendCommand({ op: "calibrate-stop" }); console.log("Calibration stops."); }
      else { sendCommand({ op: "calibrate" }); console.log("Calibration starts."); }
      return 0;
    case "pause": sendCommand({ op: "pause" }); console.log("Management is paused."); return 0;
    case "resume": sendCommand({ op: "resume" }); console.log("Management resumes."); return 0;
    case "menubar": {
      const { status } = readStatus();
      console.log(renderMenubar(status, new Date()));
      return 0;
    }
    case "hook": cmdHook(rest[0]); return 0;
    case "daemon": await runDaemon(); return 0;
    case "init": cmdInit(); return 0;
    case undefined:
    case "help":
    case "--help":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${cmd}\nRun: cg help`);
      return 2;
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof CliError ? e.message : `Error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
