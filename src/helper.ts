// Root helper calls. All root work goes through one sudo rule and one script.
import { runCmd } from "./smc";
import type { Led } from "./types";

export const HELPER_PATH = "/usr/local/libexec/chargeguard/cg-helper";
const SUDO = "/usr/bin/sudo";

export interface HelperResult {
  ok: boolean;
  err: string | null;
}

function call(cmd: string, arg: string): HelperResult {
  const r = runCmd([SUDO, "-n", HELPER_PATH, cmd, arg], 10000);
  if (r.ok) return { ok: true, err: null };
  const text = (r.err || r.out || `exit ${r.code}`).trim().split("\n")[0] ?? "failed";
  return { ok: false, err: `cg-helper ${cmd} ${arg}: ${text}` };
}

export function setLimit(n: number): HelperResult {
  return call("limit", String(Math.round(n)));
}

export function setAdapter(on: boolean): HelperResult {
  return call("adapter", on ? "on" : "off");
}

export function setLed(v: Led): HelperResult {
  return call("led", v);
}

export function setLowPower(on: boolean): HelperResult {
  return call("lowpower", on ? "1" : "0");
}

/** True if sudo allows the helper without a password. */
export function helperAvailable(): boolean {
  return runCmd([SUDO, "-n", "-l", HELPER_PATH], 5000).ok;
}

/**
 * Parse `pmset -g battlimit`.
 * Return null if no limit is set. Else return chargeSocLimitSoc of the first entry
 * with an owner that is not 0. If no such entry exists, use the first entry.
 */
export function parseBattLimit(text: string): number | null {
  if (/No battery level limits set/i.test(text)) return null;
  const entries: { owner: number; soc: number }[] = [];
  const blocks = text.split("{").slice(1);
  for (const b of blocks) {
    const soc = /chargeSocLimitSoc\s*=\s*(\d+)/.exec(b);
    if (!soc) continue;
    const owner = /chargeSocLimitOwner\s*=\s*(\d+)/.exec(b);
    entries.push({ owner: owner ? Number(owner[1]) : 0, soc: Number(soc[1]) });
  }
  if (entries.length === 0) return null;
  const owned = entries.find((e) => e.owner !== 0);
  return (owned ?? entries[0]!).soc;
}

/** Native limit that macOS reports now. null = no limit or unknown. */
export function readAppliedLimit(): number | null {
  const r = runCmd(["/usr/bin/pmset", "-g", "battlimit"], 5000);
  if (!r.ok) return null;
  return parseBattLimit(r.out);
}
