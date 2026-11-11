// Network place data: default gateway and router MAC. No Wi-Fi permission is needed.
import { normalizeMac } from "./config";
import { runCmd } from "./smc";

export interface DefaultRoute {
  gateway: string | null;
  iface: string | null;
}

/** Parse `route -n get default`. */
export function parseDefaultRoute(text: string): DefaultRoute {
  const gw = /^\s*gateway:\s*(\S+)/m.exec(text);
  const ifc = /^\s*interface:\s*(\S+)/m.exec(text);
  return { gateway: gw ? gw[1]! : null, iface: ifc ? ifc[1]! : null };
}

/** Parse `arp -n <ip>`. Return the normalized MAC or null. */
export function parseArp(text: string): string | null {
  if (/\(incomplete\)/i.test(text)) return null;
  const m = /\bat\s+([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})\b/.exec(text);
  if (!m) return null;
  return normalizeMac(m[1]!);
}

export interface RouterInfo {
  gatewayIp: string | null;
  routerMac: string | null;
}

/** Find the gateway IP and router MAC. Return nulls if there is no network. Never throws. */
export function readRouter(): RouterInfo {
  try {
    const r = runCmd(["/sbin/route", "-n", "get", "default"], 3000);
    if (!r.ok) return { gatewayIp: null, routerMac: null };
    const { gateway } = parseDefaultRoute(r.out);
    if (!gateway || !/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) return { gatewayIp: null, routerMac: null };
    let mac = parseArp(runCmd(["/usr/sbin/arp", "-n", gateway], 3000).out);
    if (!mac) {
      // The ARP entry can be missing. One ping fills it.
      runCmd(["/sbin/ping", "-c", "1", "-t", "1", gateway], 3000);
      mac = parseArp(runCmd(["/usr/sbin/arp", "-n", gateway], 3000).out);
    }
    return { gatewayIp: gateway, routerMac: mac };
  } catch {
    return { gatewayIp: null, routerMac: null };
  }
}

// ---------------------------------------------------------------------------
// Router read on events. The place only matters while the charger is connected,
// so the daemon reads the router only when the place can change.
// ---------------------------------------------------------------------------

/** Most time between two router reads while the charger is connected. */
export const ROUTER_MAX_AGE_MS = 10 * 60_000;

export interface NetCache extends RouterInfo {
  /** Network signature at the last read. See netSignature(). */
  sig: string | null;
  /** Time of the last read in ms. null = never. */
  readAt: number | null;
}

export const EMPTY_NET_CACHE: NetCache = { gatewayIp: null, routerMac: null, sig: null, readAt: null };

/** Why the daemon runs a tick now. */
export type TickReason = "start" | "timer" | "ac" | "kick";

/**
 * Decide if the daemon must read the router now. The rules:
 * - Read once at start.
 * - Never read on battery power. The place has no effect then.
 * - Read on plug-in, on a kick (wake hook, CLI, widget), and on a network change.
 * - Read if the last read is older than ROUTER_MAX_AGE_MS.
 */
export function needRouterRead(cache: NetCache, ac: boolean, reason: TickReason, sig: string, nowMs: number): boolean {
  if (cache.readAt === null || reason === "start") return true;
  if (!ac) return false;
  if (reason === "ac" || reason === "kick") return true;
  if (sig !== cache.sig) return true;
  return nowMs - cache.readAt >= ROUTER_MAX_AGE_MS;
}

/** Address list in the shape of os.networkInterfaces(). */
export type IfaceMap = Record<string, { family: string | number; address: string; internal: boolean }[] | undefined>;

/**
 * Make a short text from the IPv4 addresses of all interfaces.
 * It changes when the Mac joins another network. It needs no child process.
 */
export function netSignature(ifaces: IfaceMap): string {
  const out: string[] = [];
  for (const name of Object.keys(ifaces).sort()) {
    for (const a of ifaces[name] ?? []) {
      if (a.internal) continue;
      if (a.family !== "IPv4" && a.family !== 4) continue;
      out.push(`${name}=${a.address}`);
    }
  }
  return out.join(",");
}
