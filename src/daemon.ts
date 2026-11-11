// ChargeGuard daemon. One loop reads sensors, asks policy, and applies hardware changes.
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, DEFAULT_STATE, configDir, loadConfig, loadState, saveConfig, saveState } from "./config";
import { helperAvailable, readAppliedLimit, setAdapter, setLed, setLimit, setLowPower } from "./helper";
import { decide, nextChange, officeWindow } from "./policy";
import { networkInterfaces } from "node:os";
import { EMPTY_NET_CACHE, needRouterRead, netSignature, readRouter } from "./net";
import type { NetCache, RouterInfo, TickReason } from "./net";
import { readAcFast, readSnapshot } from "./sensors";
import { SMC_PATH, getTempKey } from "./smc";
import { PATHS } from "./types";
import type { Config, Decision, Led, NotifyMessage, OfficeWindow, Override, RuntimeState, Snapshot, Status } from "./types";

const FULL_TICK_MS = 30_000;
const FAST_POLL_MS = 3_000;
const LIMIT_CHECK_MS = 10 * 60_000;
const HELPER_OK_RECHECK_MS = 10 * 60_000;
const HELPER_BAD_RECHECK_MS = 60_000;
const KICK_DEBOUNCE_MS = 300;

export interface InboxCommand {
  op: string;
  target?: number;
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function blankSnapshot(): Snapshot {
  return {
    percent: Number.NaN, ac: false, charging: false, tempC: null, clamshell: false,
    routerMac: null, gatewayIp: null, adapterWatts: null, healthPct: null, cycleCount: null,
    minutesToEmpty: null, minutesToFull: null, batteryWatts: null, sleeping: false,
  };
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Apply one CLI command to the state. Only the daemon writes state.json. */
export function applyCommand(state: RuntimeState, cmd: InboxCommand, now: Date): RuntimeState {
  const iso = now.toISOString();
  const make = (kind: Override["kind"], target: number | null, step: Override["step"] = null): Override => ({
    kind, target, step, startedAt: iso, stepStartedAt: step ? iso : null, source: "user",
  });
  const clearIf = (kind: Override["kind"]): RuntimeState =>
    state.override?.kind === kind ? { ...state, override: null } : state;
  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null;

  switch (cmd.op) {
    case "topup":
      return { ...state, override: make("topup", num(cmd.target, 10, 100) ?? 100) };
    case "topup-stop":
      return clearIf("topup");
    case "discharge": {
      const t = num(cmd.target, 10, 99);
      return t === null ? state : { ...state, override: make("discharge", t) };
    }
    case "discharge-stop":
      return clearIf("discharge");
    case "calibrate":
      return { ...state, override: make("calibrate", null, "drain") };
    case "calibrate-stop":
      return clearIf("calibrate");
    case "pause":
      return { ...state, override: make("pause", null) };
    case "resume":
      return clearIf("pause");
    default:
      return state;
  }
}

/** Read the inbox text lines. Return the parsed commands. Bad lines are skipped. */
export function parseInbox(text: string): InboxCommand[] {
  const out: InboxCommand[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.op === "string") out.push(o as InboxCommand);
    } catch {
      /* skip a bad line */
    }
  }
  return out;
}

/** Quote text for an AppleScript string. */
export function quoteAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

function notify(n: NotifyMessage): void {
  try {
    const script = `display notification "${quoteAppleScript(n.body)}" with title "${quoteAppleScript(n.title)}"`;
    Bun.spawn(["/usr/bin/osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  } catch (e) {
    log(`Notification failed: ${e}`);
  }
}

export async function runDaemon(): Promise<void> {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const statusPath = join(dir, PATHS.status);
  const kickPath = join(dir, PATHS.kick);
  const inboxPath = join(dir, "inbox.jsonl");
  const procPath = join(dir, "inbox.processing");

  let cfg: Config = DEFAULT_CONFIG;
  try { cfg = loadConfig(dir); } catch (e) { log(`Config load failed. Using defaults. ${e}`); }
  let state: RuntimeState = DEFAULT_STATE;
  try { state = loadState(dir); } catch (e) { log(`State load failed. Using defaults. ${e}`); }

  const applied: { limit?: number; adapter?: boolean; led?: Led; lowPower?: boolean } = {};
  let helperOk = false;
  let helperCheckedAt = 0;
  let limitCheckedAt = 0;
  let appliedLimit: number | null = null;
  let lastError: string | null = null;
  let failures = 0;
  let lastAc: boolean | null = null;
  let netCache: NetCache = EMPTY_NET_CACHE;
  let lastTickAt = 0;
  let handledKick = 0;
  let lastKey = "";
  let lastStatus: Status | null = null;
  let caffeinate: ReturnType<typeof Bun.spawn> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;

  const kickMtime = (): number => {
    try { return statSync(kickPath).mtimeMs; } catch { return 0; }
  };

  const setErr = (e: string | null): void => {
    if (e !== lastError) {
      if (e) log(`Error: ${e}`);
      else log("Error cleared.");
    }
    lastError = e;
  };

  function checkHelper(nowMs: number): void {
    const wait = helperOk ? HELPER_OK_RECHECK_MS : HELPER_BAD_RECHECK_MS;
    if (nowMs - helperCheckedAt < wait) return;
    helperCheckedAt = nowMs;
    const ok = helperAvailable();
    if (ok !== helperOk) log(ok ? "Helper is available." : "Helper is not available. Run scripts/install-root.sh.");
    helperOk = ok;
  }

  function updateCaffeinate(want: boolean): void {
    if (caffeinate && caffeinate.exitCode !== null) caffeinate = null;
    if (want && !caffeinate) {
      try {
        caffeinate = Bun.spawn(["/usr/bin/caffeinate", "-i", "-w", String(process.pid)], {
          stdout: "ignore", stderr: "ignore",
        });
        log("Sleep prevention on.");
      } catch (e) {
        setErr(`caffeinate failed: ${e}`);
      }
    } else if (!want && caffeinate) {
      caffeinate.kill();
      caffeinate = null;
      log("Sleep prevention off.");
    }
  }

  function applyHardware(d: Decision, nowMs: number): void {
    checkHelper(nowMs);
    if (!helperOk) {
      setErr("The helper is not installed. Run scripts/install-root.sh.");
      return;
    }
    let err: string | null = null;
    const fail = (e: string | null): void => { if (e) err = e; };

    if (applied.limit !== d.nativeLimit) {
      const r = setLimit(d.nativeLimit);
      if (r.ok) {
        log(`Native limit set to ${d.nativeLimit}.`);
        applied.limit = d.nativeLimit;
        limitCheckedAt = nowMs;
        appliedLimit = readAppliedLimit();
      } else fail(r.err);
    } else if (nowMs - limitCheckedAt >= LIMIT_CHECK_MS) {
      limitCheckedAt = nowMs;
      appliedLimit = readAppliedLimit();
      const have = appliedLimit ?? 100;
      if (have !== d.nativeLimit) {
        log(`macOS reports limit ${have}. Target is ${d.nativeLimit}. Apply again.`);
        const r = setLimit(d.nativeLimit);
        if (r.ok) appliedLimit = readAppliedLimit();
        else fail(r.err);
      }
    }

    if (applied.adapter !== d.adapter) {
      const r = setAdapter(d.adapter);
      if (r.ok) { log(`Adapter ${d.adapter ? "on" : "off"}.`); applied.adapter = d.adapter; } else fail(r.err);
    }
    if (applied.led !== d.led) {
      const r = setLed(d.led);
      if (r.ok) { log(`LED ${d.led}.`); applied.led = d.led; } else fail(r.err);
    }
    if (d.lowPower !== null && applied.lowPower !== d.lowPower) {
      const r = setLowPower(d.lowPower);
      if (r.ok) { log(`Low Power Mode ${d.lowPower ? "on" : "off"}.`); applied.lowPower = d.lowPower; } else fail(r.err);
    }
    setErr(err);
  }

  function buildStatus(snap: Snapshot, d: Decision, st: RuntimeState, daemonUp: boolean, nowDate: Date): Status {
    let office: OfficeWindow;
    let next: string | null = null;
    try {
      office = officeWindow(snap, cfg, nowDate);
      next = nextChange(snap, cfg, st, nowDate);
    } catch (e) {
      office = { topupStart: null, end: null, graceEnd: null, etaMin: null, tooSlow: false };
      log(`Policy info failed: ${e}`);
    }
    const placeLabel =
      d.place === "home" || d.place === "office" ? cfg.places[d.place].label : d.place === "offline" ? "No network" : "Away";
    return {
      version: 1,
      updatedAt: nowDate.toISOString(),
      snapshot: snap,
      decision: d,
      state: st,
      config: cfg,
      placeLabel,
      office,
      next,
      health: {
        daemon: daemonUp,
        smc: existsSync(SMC_PATH),
        backend: helperOk ? "native" : "none",
        appliedLimit,
        helper: helperOk,
        tempKey: getTempKey(),
        lastError,
      },
    };
  }

  function writeStatus(s: Status): void {
    try { writeAtomic(statusPath, JSON.stringify(s, null, 2)); } catch (e) { log(`Status write failed: ${e}`); }
  }

  function processInbox(now: Date): void {
    try {
      if (existsSync(inboxPath)) {
        if (existsSync(procPath)) {
          // A crash left old commands. Append the new ones to them.
          writeFileSync(procPath, readFileSync(procPath, "utf8") + readFileSync(inboxPath, "utf8"));
          unlinkSync(inboxPath);
        } else renameSync(inboxPath, procPath);
      }
      if (!existsSync(procPath)) return;
      const cmds = parseInbox(readFileSync(procPath, "utf8"));
      for (const c of cmds) {
        state = applyCommand(state, c, now);
        log(`Command: ${c.op}${c.target !== undefined ? " " + c.target : ""}`);
      }
      unlinkSync(procPath);
    } catch (e) {
      log(`Inbox failed: ${e}`);
    }
  }

  function failSafe(nowDate: Date, why: string): void {
    const r1 = setAdapter(true);
    const r2 = setLed("system");
    if (r1.ok) applied.adapter = true;
    if (r2.ok) applied.led = "system";
    setErr(why);
    const snap = lastStatus?.snapshot ?? blankSnapshot();
    const d: Decision = {
      nativeLimit: applied.limit ?? 100, adapter: true, led: "system", lowPower: null, preventSleep: false,
      target: 100, place: "offline", mode: "error", reason: "sensor-fail",
      summary: "The sensors fail. Charging is on and the adapter is on.", notify: [],
    };
    state = { ...state, sensorFailures: failures };
    updateCaffeinate(false);
    const s = buildStatus(snap, d, state, true, nowDate);
    lastStatus = s;
    writeStatus(s);
  }

  // Read the router only when the place can change. See needRouterRead() in net.ts.
  function routerFor(reason: TickReason, nowMs: number): (ac: boolean) => RouterInfo {
    return (ac) => {
      const sig = netSignature(networkInterfaces());
      if (!needRouterRead(netCache, ac, reason, sig, nowMs)) return netCache;
      const r = readRouter();
      if (r.routerMac !== netCache.routerMac) log(`Router read (${reason}): ${r.routerMac ?? "none"}.`);
      netCache = { ...r, sig, readAt: nowMs };
      return netCache;
    };
  }

  function tick(reason: TickReason): void {
    const nowDate = new Date();
    const nowMs = nowDate.getTime();
    lastTickAt = nowMs;
    handledKick = kickMtime();
    try { cfg = loadConfig(dir); } catch (e) { setErr(`Config error: ${e}`); }
    processInbox(nowDate);

    let snap: Snapshot | null = null;
    try {
      const s = readSnapshot(routerFor(reason, nowMs));
      if (Number.isNaN(s.percent)) throw new Error("percent is NaN");
      snap = s;
    } catch (e) {
      failures++;
      log(`Sensor read failed (${failures}): ${e}`);
    }
    if (!snap) {
      if (failures >= 3) failSafe(nowDate, "The sensors failed 3 times. Fail-safe is active.");
      return;
    }
    failures = 0;
    state = { ...state, sensorFailures: 0 };
    lastAc = snap.ac;

    const res = decide(snap, cfg, state, nowDate);
    state = res.state;
    const d = res.decision;
    try { saveState(dir, state); } catch (e) { log(`State save failed: ${e}`); }

    applyHardware(d, nowMs);
    updateCaffeinate(d.preventSleep);

    if (d.reason === "calibration-done") {
      const today = nowDate.toISOString().slice(0, 10);
      if (cfg.lastCalibration !== today) {
        cfg = { ...cfg, lastCalibration: today };
        try { saveConfig(dir, cfg); } catch (e) { log(`Config save failed: ${e}`); }
      }
    }
    for (const n of d.notify) {
      if (cfg.notifications[n.event] === false) continue;
      log(`Notify: ${n.title}. ${n.body}`);
      notify(n);
    }

    const key = `${d.mode}|${d.reason}|${d.target}|${d.place}`;
    if (key !== lastKey) {
      log(`Mode ${d.mode}. Reason ${d.reason}. Target ${d.target}. Place ${d.place}. ${d.summary}`);
      lastKey = key;
    }

    const s = buildStatus(snap, d, state, true, nowDate);
    lastStatus = s;
    writeStatus(s);
  }

  function safeTick(reason: TickReason): void {
    try { tick(reason); } catch (e) { log(`Tick failed: ${e}`); }
  }

  function shutdown(sig: string): void {
    log(`Signal ${sig}. Fail-safe: adapter on, LED system.`);
    setAdapter(true);
    setLed("system");
    if (caffeinate) { try { caffeinate.kill(); } catch { /* ignore */ } }
    if (lastStatus) {
      lastStatus = { ...lastStatus, updatedAt: new Date().toISOString(), health: { ...lastStatus.health, daemon: false } };
      writeStatus(lastStatus);
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    watch(dir, (_ev, name) => {
      if (name !== PATHS.kick) return;
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => safeTick("kick"), KICK_DEBOUNCE_MS);
    });
  } catch (e) {
    log(`Watch failed. The poll finds the kick file. ${e}`);
  }

  log(`ChargeGuard daemon starts. PID ${process.pid}.`);
  safeTick("start");

  setInterval(() => {
    const nowMs = Date.now();
    if (nowMs - lastTickAt >= FULL_TICK_MS) return safeTick("timer");
    if (kickMtime() > handledKick) return safeTick("kick");
    const ac = readAcFast();
    if (ac !== null && lastAc !== null && ac !== lastAc) {
      log(`AC changed to ${ac ? "connected" : "disconnected"}.`);
      safeTick("ac");
    }
  }, FAST_POLL_MS);

  // Keep the process alive.
  await new Promise<never>(() => {});
}
