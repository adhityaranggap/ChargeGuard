import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_STATE } from "../src/config";
import { renderMenubar } from "../src/menubar";
import type { Config, Decision, Snapshot, Status } from "../src/types";

const NOW = new Date("2026-11-11T12:00:00.000Z");

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    percent: 80, ac: true, charging: false, tempC: 31.2, clamshell: false,
    routerMac: "9c:71:3a:40:db:9f", gatewayIp: "192.168.100.1", adapterWatts: 7,
    healthPct: 100, cycleCount: 2, minutesToEmpty: null, minutesToFull: null,
    batteryWatts: 0.2, sleeping: false, ...over,
  };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    nativeLimit: 80, adapter: true, led: "green", lowPower: null, preventSleep: false,
    target: 80, place: "home", mode: "holding", reason: "limit",
    summary: "Stops at 80%. Starts again at 75%.", notify: [], ...over,
  };
}

function status(over: { snap?: Partial<Snapshot>; dec?: Partial<Decision>; cfg?: Partial<Config>; at?: Date; next?: string | null } = {}): Status {
  const config = { ...structuredClone(DEFAULT_CONFIG), ...over.cfg } as Config;
  return {
    version: 1,
    updatedAt: (over.at ?? NOW).toISOString(),
    snapshot: snap(over.snap),
    decision: decision(over.dec),
    state: structuredClone(DEFAULT_STATE),
    config,
    placeLabel: "Home",
    office: { topupStart: null, end: null, graceEnd: null, etaMin: null, tooSlow: false },
    next: over.next ?? null,
    health: { daemon: true, smc: true, backend: "native", appliedLimit: 80, helper: true, tempKey: "TB0T", lastError: null },
  };
}

describe("renderMenubar", () => {
  test("null status shows the warning", () => {
    const out = renderMenubar(null, NOW);
    expect(out.split("\n")[0]).toContain("⚠");
    expect(out).toContain("ChargeGuard is not running");
  });

  test("stale status shows the warning", () => {
    const old = new Date(NOW.getTime() - 120_000);
    const out = renderMenubar(status({ at: old }), NOW);
    expect(out.split("\n")[0]).toContain("⚠");
    expect(out).toContain("ChargeGuard is not running");
  });

  test("fresh status is not stale", () => {
    const ok = new Date(NOW.getTime() - 30_000);
    expect(renderMenubar(status({ at: ok }), NOW)).not.toContain("is not running");
  });

  test("holding: battery icon, green, percent, limit check", () => {
    const out = renderMenubar(status({ cfg: { menubar: { icon: "battery", showPercent: true, sections: ["status", "limit"] } } }), NOW);
    const first = out.split("\n")[0]!;
    expect(first).toContain("80%");
    expect(first).toContain("sfimage=battery.75");
    expect(first).toContain("sfcolor=#30D158");
    expect(out).toContain("---");
    const body = out.split("\n").slice(out.split("\n").indexOf("---") + 1);
    const line80 = body.find((l) => l.startsWith("80% |"))!;
    expect(line80).toContain("param1=limit param2=80");
    expect(line80).toContain("checked=true");
    expect(line80).toContain("terminal=false refresh=true");
    const line90 = body.find((l) => l.startsWith("90% |"))!;
    expect(line90).not.toContain("checked=true");
  });

  test("charging at 100 uses the bolt symbol", () => {
    const out = renderMenubar(
      status({ snap: { percent: 100, charging: true }, dec: { mode: "charging" }, cfg: { menubar: { icon: "battery", showPercent: false, sections: ["status"] } } }),
      NOW,
    );
    const first = out.split("\n")[0]!;
    expect(first).toContain("sfimage=battery.100.bolt");
    expect(first).toContain("sfcolor=#FFD60A");
    expect(first.startsWith("100%")).toBe(false);
  });

  test("percent, bolt and leaf icons", () => {
    const mk = (icon: "percent" | "bolt" | "leaf") =>
      renderMenubar(status({ cfg: { menubar: { icon, showPercent: false, sections: ["status"] } } }), NOW).split("\n")[0]!;
    expect(mk("percent")).toContain("80%");
    expect(mk("bolt")).toContain("sfimage=bolt.fill");
    expect(mk("leaf")).toContain("sfimage=leaf.fill");
  });

  test("office top-up: blue, office hours section with next line", () => {
    const out = renderMenubar(
      status({
        snap: { percent: 85, charging: true },
        dec: { mode: "topup", reason: "office-topup", target: 100, nativeLimit: 100, place: "office", summary: "Top-up to 100% for the office end." },
        next: "Top-up starts 15:30. Full by about 17:00.",
        cfg: { menubar: { icon: "battery", showPercent: true, sections: ["status", "officeHours"] } },
      }),
      NOW,
    );
    expect(out.split("\n")[0]).toContain("sfcolor=#0A84FF");
    expect(out).toContain("Top-up to 100% for the office end.");
    expect(out).toContain("Top-up starts 15:30. Full by about 17:00.");
    expect(out).toContain("Office hours");
    expect(out).toContain("param1=office-hours");
  });

  test("custom sections order", () => {
    const out = renderMenubar(
      status({ cfg: { menubar: { icon: "percent", showPercent: true, sections: ["settings", "limit", "status"] } } }),
      NOW,
    );
    const iSettings = out.indexOf("Open config in editor");
    const iLimit = out.indexOf("Charge limit");
    const iStatus = out.indexOf("Stops at 80%");
    expect(iSettings).toBeGreaterThan(0);
    expect(iSettings).toBeLessThan(iLimit);
    expect(iLimit).toBeLessThan(iStatus);
    expect(out).not.toContain("Save current Wi-Fi");
  });

  test("actions section and place section", () => {
    const out = renderMenubar(
      status({ cfg: { menubar: { icon: "percent", showPercent: true, sections: ["place", "actions"] } } }),
      NOW,
    );
    expect(out).toContain("param1=place param2=save param3=home");
    expect(out).toContain("param1=place param2=save param3=office");
    expect(out).toContain("Top up to 100%");
    expect(out).toContain("param1=pause");
    expect(out).toContain("Calibrate");
    expect(out).toContain("param1=discharge param2=80");
  });
});
