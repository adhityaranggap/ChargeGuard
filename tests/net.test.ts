import { describe, expect, test } from "bun:test";
import { EMPTY_NET_CACHE, ROUTER_MAX_AGE_MS, needRouterRead, netSignature } from "../src/net";
import type { NetCache } from "../src/net";

const T0 = 1_000_000;
const cache: NetCache = { gatewayIp: "192.168.100.1", routerMac: "9c:71:3a:00:00:01", sig: "en0=192.168.100.5", readAt: T0 };

describe("needRouterRead", () => {
  test("reads at start and when nothing was read", () => {
    expect(needRouterRead(EMPTY_NET_CACHE, false, "timer", "x", T0)).toBe(true);
    expect(needRouterRead(cache, false, "start", cache.sig!, T0)).toBe(true);
  });

  test("never reads on battery power after the first read", () => {
    expect(needRouterRead(cache, false, "ac", "other", T0 + ROUTER_MAX_AGE_MS * 3)).toBe(false);
    expect(needRouterRead(cache, false, "kick", cache.sig!, T0)).toBe(false);
  });

  test("reads on plug-in and on a kick", () => {
    expect(needRouterRead(cache, true, "ac", cache.sig!, T0 + 1000)).toBe(true);
    expect(needRouterRead(cache, true, "kick", cache.sig!, T0 + 1000)).toBe(true);
  });

  test("reads on AC when the network changes", () => {
    expect(needRouterRead(cache, true, "timer", "en0=10.0.0.7", T0 + 1000)).toBe(true);
  });

  test("skips the timer read on AC when the network is the same and the read is new", () => {
    expect(needRouterRead(cache, true, "timer", cache.sig!, T0 + 30_000)).toBe(false);
  });

  test("reads on AC when the last read is too old", () => {
    expect(needRouterRead(cache, true, "timer", cache.sig!, T0 + ROUTER_MAX_AGE_MS)).toBe(true);
  });
});

describe("netSignature", () => {
  test("keeps external IPv4 addresses in name order", () => {
    const sig = netSignature({
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      en0: [
        { family: "IPv6", address: "fe80::1", internal: false },
        { family: "IPv4", address: "192.168.100.5", internal: false },
      ],
      bridge0: [{ family: 4, address: "10.0.0.1", internal: false }],
      utun3: undefined,
    });
    expect(sig).toBe("bridge0=10.0.0.1,en0=192.168.100.5");
  });

  test("is empty with no network", () => {
    expect(netSignature({ lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }] })).toBe("");
  });
});
