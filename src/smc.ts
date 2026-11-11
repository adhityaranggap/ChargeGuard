// SMC read access. The smc binary reads the battery temperature without root.
import { existsSync } from "node:fs";

export const SMC_PATH = "/usr/local/libexec/chargeguard/smc";
export const TEMP_KEYS = ["TB0T", "TB1T", "TB2T"] as const;

export interface RunResult {
  ok: boolean;
  code: number | null;
  out: string;
  err: string;
}

/** Run a command and wait. Never throws. A timeout stops the child. */
export function runCmd(cmd: string[], timeoutMs = 5000): RunResult {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    return {
      ok: r.exitCode === 0,
      code: r.exitCode,
      out: r.stdout ? r.stdout.toString() : "",
      err: r.stderr ? r.stderr.toString() : "",
    };
  } catch (e) {
    return { ok: false, code: null, out: "", err: String(e) };
  }
}

/**
 * Parse one line of `smc -k KEY -r`, for example "  TB0T  [flt ]  33 (bytes 64 66 02 42)".
 * Read the 4 bytes as a little-endian float32 first. Use the printed integer if that fails.
 * Return null if the key has no data or the value is out of range.
 */
export function parseSmcFloat(text: string): number | null {
  if (/no data/i.test(text)) return null;
  const bytes = /\(bytes\s+((?:[0-9a-fA-F]{2}\s*){1,16})\)/.exec(text);
  const isFloat = /\[flt\s*\]/.test(text);
  let value: number | null = null;
  if (isFloat && bytes) {
    const parts = bytes[1]!.trim().split(/\s+/);
    if (parts.length === 4) {
      const buf = new DataView(new ArrayBuffer(4));
      parts.forEach((p, i) => buf.setUint8(i, parseInt(p, 16)));
      const f = buf.getFloat32(0, true);
      if (Number.isFinite(f)) value = Math.round(f * 10) / 10;
    }
  }
  if (value === null) {
    const m = /\]\s+(-?\d+(?:\.\d+)?)/.exec(text);
    if (m) value = Number(m[1]);
  }
  if (value === null || !Number.isFinite(value)) return null;
  if (value < -20 || value > 120) return null;
  return value;
}

let lastKey: string | null = null;

/** Key that gave the last temperature. null if none worked. */
export function getTempKey(): string | null {
  return lastKey;
}

/** Read the battery temperature in degrees C. Return the highest value of all keys. */
export function readTemp(): number | null {
  if (!existsSync(SMC_PATH)) {
    lastKey = null;
    return null;
  }
  let best: number | null = null;
  let bestKey: string | null = null;
  for (const key of TEMP_KEYS) {
    const r = runCmd([SMC_PATH, "-k", key, "-r"], 3000);
    if (!r.ok && !r.out) continue;
    const v = parseSmcFloat(r.out);
    if (v !== null && (best === null || v > best)) {
      best = v;
      bestKey = key;
    }
  }
  lastKey = bestKey;
  return best;
}
