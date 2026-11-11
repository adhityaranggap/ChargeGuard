// Hardware reads. The parse functions take text, so tests can run with fixture strings.
import type { Snapshot } from "./types";
import { readRouter } from "./net";
import type { RouterInfo } from "./net";
import { readTemp, runCmd } from "./smc";

export interface BatteryInfo {
  percent: number | null;
  ac: boolean;
  charging: boolean;
  adapterWatts: number | null;
  healthPct: number | null;
  cycleCount: number | null;
  minutesToEmpty: number | null;
  minutesToFull: number | null;
  batteryWatts: number | null;
}

/** First integer value of "Key" = N or "Key"=N. */
function intKey(text: string, key: string): number | null {
  const m = new RegExp(`"${key}"\\s*=\\s*(\\d+)`).exec(text);
  return m ? Number(m[1]) : null;
}

/** Top-level Yes/No value. Nested values use 0 and 1, so they do not match. */
function yesNo(text: string, key: string): boolean | null {
  const m = new RegExp(`"${key}"\\s*=\\s*(Yes|No)\\b`).exec(text);
  return m ? m[1] === "Yes" : null;
}

function minutes(v: number | null): number | null {
  return v === null || v >= 65535 ? null : v;
}

/** BatteryPower is an unsigned 64-bit mW value. Values from 2^63 up are negative. */
export function parseBatteryPower(raw: string): number | null {
  try {
    let v = BigInt(raw);
    if (v >= 2n ** 63n) v -= 2n ** 64n;
    return Number(v) / 1000;
  } catch {
    return null;
  }
}

/** Parse `ioreg -r -c AppleSmartBattery`. Both multi-line and one-line text work. */
export function parseBattery(text: string): BatteryInfo {
  const ac = yesNo(text, "ExternalConnected") ?? false;
  const charging = yesNo(text, "IsCharging") ?? false;

  let adapterWatts: number | null = null;
  if (ac) {
    const m = /"AdapterDetails"\s*=\s*\{[^}]*?"Watts"=(\d+)/.exec(text);
    if (m) adapterWatts = Number(m[1]);
  }

  const raw = intKey(text, "AppleRawMaxCapacity");
  const design = intKey(text, "DesignCapacity");
  let healthPct: number | null = null;
  if (raw !== null && design !== null && design > 0) {
    healthPct = Math.min(100, Math.round((raw / design) * 100));
  }

  let batteryWatts: number | null = null;
  const block = /"BatteryData"\s*=\s*\{([^}]*)\}/.exec(text);
  const pm = /"BatteryPower"\s*=\s*(\d+)/.exec(block ? block[1]! : text);
  if (pm) batteryWatts = parseBatteryPower(pm[1]!);

  return {
    percent: intKey(text, "CurrentCapacity"),
    ac,
    charging,
    adapterWatts,
    healthPct,
    cycleCount: intKey(text, "CycleCount"),
    minutesToEmpty: minutes(intKey(text, "AvgTimeToEmpty")),
    minutesToFull: minutes(intKey(text, "AvgTimeToFull")),
    batteryWatts,
  };
}

/** Parse the AC state only. Used by the fast poll. null = not found. */
export function parseAc(text: string): boolean | null {
  return yesNo(text, "ExternalConnected");
}

/** Parse the lid state from `ioreg -r -k AppleClamshellState -d 4`. true = lid closed. */
export function parseClamshell(text: string): boolean {
  return yesNo(text, "AppleClamshellState") ?? false;
}

/** Parse the percent from `pmset -g batt`, for example "98%; AC attached". */
export function parsePmsetPercent(text: string): number | null {
  const m = /(\d{1,3})%/.exec(text);
  return m ? Number(m[1]) : null;
}

const IOREG = "/usr/sbin/ioreg";

/** Cheap AC check. null = the read failed. */
export function readAcFast(): boolean | null {
  const r = runCmd([IOREG, "-r", "-c", "AppleSmartBattery", "-k", "ExternalConnected"], 3000);
  return r.ok ? parseAc(r.out) : null;
}

/**
 * Read all sensors. Throws if the battery cannot be read.
 * getNet gives the router data. It gets the AC state, so the caller can skip the router read on battery.
 */
export function readSnapshot(getNet: (ac: boolean) => RouterInfo = () => readRouter()): Snapshot {
  const r = runCmd([IOREG, "-r", "-c", "AppleSmartBattery"], 5000);
  if (!r.ok || !r.out) throw new Error(`ioreg failed: ${r.err.trim() || r.code}`);
  const b = parseBattery(r.out);

  let percent = b.percent;
  if (percent === null) {
    const p = runCmd(["/usr/bin/pmset", "-g", "batt"], 3000);
    percent = p.ok ? parsePmsetPercent(p.out) : null;
  }

  const lid = runCmd([IOREG, "-r", "-k", "AppleClamshellState", "-d", "4"], 3000);
  const net = getNet(b.ac);

  return {
    percent: percent === null ? Number.NaN : percent,
    ac: b.ac,
    charging: b.charging,
    tempC: readTemp(),
    clamshell: lid.ok ? parseClamshell(lid.out) : false,
    routerMac: net.routerMac,
    gatewayIp: net.gatewayIp,
    adapterWatts: b.adapterWatts,
    healthPct: b.healthPct,
    cycleCount: b.cycleCount,
    minutesToEmpty: b.minutesToEmpty,
    minutesToFull: b.minutesToFull,
    batteryWatts: b.batteryWatts,
    sleeping: false,
  };
}
