import { afterEach, describe, test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  configDir,
  formatClock,
  loadConfig,
  loadState,
  normalizeMac,
  parseClock,
  parseTrips,
  saveConfig,
  saveState,
  validateConfig,
  validateState,
} from "../src/config";
import type { PlaceKind } from "../src/types";

describe("normalizeMac", () => {
  test("accepts the normal colon form", () => {
    expect(normalizeMac("9c:71:3a:40:db:9f")).toBe("9c:71:3a:40:db:9f");
  });
  test("accepts dashes and upper case", () => {
    expect(normalizeMac("9C-71-3A-40-DB-9F")).toBe("9c:71:3a:40:db:9f");
  });
  test("pads the short arp form", () => {
    expect(normalizeMac("9c:71:3a:4:db:9f")).toBe("9c:71:3a:04:db:9f");
    expect(normalizeMac("0:1:2:3:4:5")).toBe("00:01:02:03:04:05");
  });
  test("rejects bad input", () => {
    expect(normalizeMac("")).toBeNull();
    expect(normalizeMac("hello")).toBeNull();
    expect(normalizeMac("9c:71:3a:40:db")).toBeNull();
    expect(normalizeMac("9c:71:3a:40:db:9f:00")).toBeNull();
    expect(normalizeMac("9c:71:3a:40:db:zz")).toBeNull();
    expect(normalizeMac("9c:71:3a:400:db:9f")).toBeNull();
  });
});

describe("clock helpers", () => {
  test("parseClock", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("08:30")).toBe(510);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("abc")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
  test("formatClock", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(510)).toBe("08:30");
    expect(formatClock(1439)).toBe("23:59");
    expect(parseClock(formatClock(930))).toBe(930);
  });
});

describe("validateConfig", () => {
  test("undefined gives a copy of the defaults", () => {
    const c = validateConfig(undefined);
    expect(c).toEqual(DEFAULT_CONFIG);
    c.places.home.routers.push("x");
    expect(DEFAULT_CONFIG.places.home.routers).toHaveLength(0);
  });

  test("an empty object gives the defaults", () => {
    expect(validateConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("a value that is not an object throws", () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig("text")).toThrow();
    expect(() => validateConfig(5)).toThrow();
    expect(() => validateConfig([])).toThrow();
  });

  test("numbers are clamped", () => {
    const hi = validateConfig({
      limit: 500,
      awayLimit: 500,
      sail: 99,
      heat: { maxC: 99 },
      lowPower: { belowPct: 99 },
      officeHours: { leadMin: 999, graceMin: 9999 },
    });
    expect(hi.limit).toBe(100);
    expect(hi.awayLimit).toBe(100);
    expect(hi.sail).toBe(20);
    expect(hi.heat.maxC).toBe(50);
    expect(hi.lowPower.belowPct).toBe(50);
    expect(hi.officeHours.leadMin).toBe(240);
    expect(hi.officeHours.graceMin).toBe(480);

    const lo = validateConfig({
      limit: 1,
      awayLimit: -5,
      sail: -1,
      heat: { maxC: 1 },
      lowPower: { belowPct: 0 },
      officeHours: { leadMin: -10, graceMin: -10 },
    });
    expect(lo.limit).toBe(10);
    expect(lo.awayLimit).toBe(10);
    expect(lo.sail).toBe(0);
    expect(lo.heat.maxC).toBe(25);
    expect(lo.lowPower.belowPct).toBe(5);
    expect(lo.officeHours.leadMin).toBe(0);
    expect(lo.officeHours.graceMin).toBe(0);
  });

  test("bad number types use the defaults", () => {
    const c = validateConfig({ limit: "high", sail: NaN, awayLimit: null });
    expect(c.limit).toBe(80);
    expect(c.sail).toBe(5);
    expect(c.awayLimit).toBe(100);
  });

  test("heat resumeC must be below maxC", () => {
    expect(validateConfig({ heat: { maxC: 40, resumeC: 45 } }).heat).toMatchObject({ maxC: 40, resumeC: 37 });
    expect(validateConfig({ heat: { maxC: 40, resumeC: 40 } }).heat.resumeC).toBe(37);
    expect(validateConfig({ heat: { maxC: 40, resumeC: 30 } }).heat.resumeC).toBe(30);
  });

  test("router MACs are normalized, deduplicated, and checked", () => {
    const c = validateConfig({
      places: {
        home: {
          routers: ["9C-71-3A-40-DB-9F", "9c:71:3a:40:db:9f", "9c:71:3a:4:db:9f", "bad", 12, null],
        },
        office: { routers: ["AA:BB:CC:DD:EE:01"], label: "Work", limit: 90 },
      },
    });
    expect(c.places.home.routers).toEqual(["9c:71:3a:40:db:9f", "9c:71:3a:04:db:9f"]);
    expect(c.places.office.routers).toEqual(["aa:bb:cc:dd:ee:01"]);
    expect(c.places.office.label).toBe("Work");
    expect(c.places.office.limit).toBe(90);
    expect(c.places.home.limit).toBeNull();
  });

  test("bad clock strings use the defaults", () => {
    const c = validateConfig({ officeHours: { start: "25:00", end: "noon" } });
    expect(c.officeHours.start).toBe("08:00");
    expect(c.officeHours.end).toBe("17:00");
    const ok = validateConfig({ officeHours: { start: "7:30", end: "18:15" } });
    expect(ok.officeHours.start).toBe("07:30");
    expect(ok.officeHours.end).toBe("18:15");
  });

  test("days are filtered, unique, and sorted", () => {
    const c = validateConfig({ officeHours: { days: [5, 1, 1, 9, -1, 2.5, "3", 0] } });
    expect(c.officeHours.days).toEqual([0, 1, 5]);
    expect(validateConfig({ officeHours: { days: "mon" } }).officeHours.days).toEqual([1, 2, 3, 4, 5]);
  });

  test("schedule rules with bad fields are dropped", () => {
    const c = validateConfig({
      schedule: [
        { id: "ok1", enabled: true, days: [1, 1, 9], time: "6:30", action: { kind: "topup" } },
        { id: "ok2", enabled: false, days: [2], time: "07:00", action: { kind: "limit", value: 500 } },
        { id: "bad-time", enabled: true, days: [1], time: "99:00", action: { kind: "topup" } },
        { id: "bad-action", enabled: true, days: [1], time: "06:00", action: { kind: "explode" } },
        { id: "bad-value", enabled: true, days: [1], time: "06:00", action: { kind: "discharge" } },
        { id: "bad-days", enabled: true, days: "all", time: "06:00", action: { kind: "topup" } },
        { enabled: true, days: [1], time: "06:00", action: { kind: "topup" } },
        { id: "ok1", enabled: true, days: [1], time: "09:00", action: { kind: "topup" } },
        "text",
        null,
      ],
    });
    expect(c.schedule.map((r) => r.id)).toEqual(["ok1", "ok2"]);
    expect(c.schedule[0]).toEqual({ id: "ok1", enabled: true, days: [1], time: "06:30", action: { kind: "topup" } });
    expect(c.schedule[1]?.action).toEqual({ kind: "limit", value: 100 });
  });

  test("notifications keep only boolean values for known events", () => {
    const c = validateConfig({ notifications: { plug: false, unplug: "no", other: true, heatPause: true } });
    expect(c.notifications).toEqual({ plug: false, heatPause: true });
  });

  test("menubar and flags are merged over the defaults", () => {
    const c = validateConfig({
      magsafeLed: false,
      menubar: { icon: "leaf", sections: ["status", "status", "nope", "settings"] },
    });
    expect(c.magsafeLed).toBe(false);
    expect(c.menubar.icon).toBe("leaf");
    expect(c.menubar.showPercent).toBe(true);
    expect(c.menubar.sections).toEqual(["status", "settings"]);
    expect(validateConfig({ menubar: { icon: "star" } }).menubar.icon).toBe("battery");
  });

  test("widget corner has a default and falls back for bad values", () => {
    expect(validateConfig({ limit: 70 }).widget.corner).toBe("bottom-left");
    expect(validateConfig({ widget: { corner: "top-right" } }).widget.corner).toBe("top-right");
    expect(validateConfig({ widget: { corner: "middle" } }).widget.corner).toBe("bottom-left");
    expect(validateConfig({ widget: "top-right" }).widget.corner).toBe("bottom-left");
  });

  test("widget theme, scale, and panelHeight have defaults", () => {
    const w = validateConfig({ limit: 70 }).widget;
    expect(w.theme).toBe("auto");
    expect(w.scale).toBe(100);
    expect(w.panelHeight).toBe(85);
  });

  test("widget theme, scale, and panelHeight keep valid values", () => {
    const w = validateConfig({ widget: { theme: "midnight", scale: 130, panelHeight: 60 } }).widget;
    expect(w.theme).toBe("midnight");
    expect(w.scale).toBe(130);
    expect(w.panelHeight).toBe(60);
  });

  test("widget scale rounds to the nearest 5 and is clamped to 70..150", () => {
    expect(validateConfig({ widget: { scale: 112 } }).widget.scale).toBe(110);
    expect(validateConfig({ widget: { scale: 10 } }).widget.scale).toBe(70);
    expect(validateConfig({ widget: { scale: 999 } }).widget.scale).toBe(150);
    expect(validateConfig({ widget: { scale: "big" } }).widget.scale).toBe(100);
  });

  test("widget scale maps the old widget.size values", () => {
    expect(validateConfig({ widget: { size: "small" } }).widget.scale).toBe(85);
    expect(validateConfig({ widget: { size: "medium" } }).widget.scale).toBe(100);
    expect(validateConfig({ widget: { size: "large" } }).widget.scale).toBe(115);
    expect(validateConfig({ widget: { size: "xlarge" } }).widget.scale).toBe(130);
    expect(validateConfig({ widget: { size: "huge" } }).widget.scale).toBe(100);
    expect(validateConfig({ widget: { size: "toString" } }).widget.scale).toBe(100);
    expect(validateConfig({ widget: { size: "large", scale: 90 } }).widget.scale).toBe(90);
    expect("size" in validateConfig({ widget: { size: "large" } }).widget).toBe(false);
  });

  test("widget theme falls back for bad values", () => {
    const w = validateConfig({ widget: { theme: "neon" } }).widget;
    expect(w.theme).toBe("auto");
    expect(validateConfig({ widget: { theme: 3 } }).widget.theme).toBe("auto");
  });

  test("placeMode is auto by default and falls back for bad values", () => {
    expect(DEFAULT_CONFIG.placeMode).toBe("auto");
    expect(validateConfig({ limit: 70 }).placeMode).toBe("auto");
    expect(validateConfig({ placeMode: "office" }).placeMode).toBe("office");
    expect(validateConfig({ placeMode: "away" }).placeMode).toBe("away");
    expect(validateConfig({ placeMode: "offline" }).placeMode).toBe("auto");
    expect(validateConfig({ placeMode: 3 }).placeMode).toBe("auto");
  });

  test("widget panelHeight is clamped to 40..100", () => {
    expect(validateConfig({ widget: { panelHeight: 10 } }).widget.panelHeight).toBe(40);
    expect(validateConfig({ widget: { panelHeight: 150 } }).widget.panelHeight).toBe(100);
    expect(validateConfig({ widget: { panelHeight: "tall" } }).widget.panelHeight).toBe(85);
  });

  test("calendar has the defaults and is off", () => {
    expect(DEFAULT_CONFIG.calendar).toEqual({
      enabled: false,
      arriveBufferMin: 10,
      fallbackTravelMin: 45,
      graceMin: 30,
      lookaheadH: 24,
      minTravelMin: 10,
    });
    expect(validateConfig({}).calendar).toEqual(DEFAULT_CONFIG.calendar);
    expect(validateConfig({ calendar: "on" }).calendar).toEqual(DEFAULT_CONFIG.calendar);
  });

  test("calendar numbers are clamped", () => {
    const hi = validateConfig({
      calendar: { enabled: true, arriveBufferMin: 999, fallbackTravelMin: 999, graceMin: 999, lookaheadH: 999, minTravelMin: 999 },
    }).calendar;
    expect(hi).toEqual({
      enabled: true,
      arriveBufferMin: 120,
      fallbackTravelMin: 300,
      graceMin: 240,
      lookaheadH: 72,
      minTravelMin: 120,
    });
    const lo = validateConfig({
      calendar: { arriveBufferMin: -5, fallbackTravelMin: -5, graceMin: -5, lookaheadH: 0, minTravelMin: -5 },
    }).calendar;
    expect(lo).toEqual({
      enabled: false,
      arriveBufferMin: 0,
      fallbackTravelMin: 0,
      graceMin: 0,
      lookaheadH: 1,
      minTravelMin: 0,
    });
  });

  test("bad calendar types use the defaults", () => {
    const c = validateConfig({
      calendar: { enabled: "yes", arriveBufferMin: "ten", fallbackTravelMin: NaN, graceMin: null, lookaheadH: {}, minTravelMin: "far" },
    }).calendar;
    expect(c).toEqual(DEFAULT_CONFIG.calendar);
  });

  test("tripTopupStart is a known notification event", () => {
    expect(validateConfig({ notifications: { tripTopupStart: false } }).notifications).toEqual({ tripTopupStart: false });
  });

  test("place address is null by default and is trimmed", () => {
    const d = validateConfig({});
    expect(d.places.home.address).toBeNull();
    expect(d.places.office.address).toBeNull();
    const c = validateConfig({
      places: { home: { address: "  Jl. Sudirman 1, Jakarta  " }, office: { address: "Jl. Gatot Subroto 9" } },
    });
    expect(c.places.home.address).toBe("Jl. Sudirman 1, Jakarta");
    expect(c.places.office.address).toBe("Jl. Gatot Subroto 9");
  });

  test("place address with a bad value is null", () => {
    const c = validateConfig({
      places: { home: { address: "   " }, office: { address: "x".repeat(201) } },
    });
    expect(c.places.home.address).toBeNull();
    expect(c.places.office.address).toBeNull();
    expect(validateConfig({ places: { home: { address: 5 } } }).places.home.address).toBeNull();
    expect(validateConfig({ places: { home: { address: "x".repeat(200) } } }).places.home.address).toBe("x".repeat(200));
  });

  test("version is always 1 and bad lastCalibration is null", () => {
    expect(validateConfig({ version: 7 }).version).toBe(1);
    expect(validateConfig({ lastCalibration: "not a date" }).lastCalibration).toBeNull();
    expect(validateConfig({ lastCalibration: "2026-11-01T10:00:00.000Z" }).lastCalibration).toBe(
      "2026-11-01T10:00:00.000Z",
    );
  });
});

describe("validateState", () => {
  test("undefined and empty give the defaults", () => {
    expect(validateState(undefined)).toEqual(DEFAULT_STATE);
    expect(validateState({})).toEqual(DEFAULT_STATE);
  });

  test("a value that is not an object throws", () => {
    expect(() => validateState("x")).toThrow();
    expect(() => validateState(null)).toThrow();
  });

  test("bad fields change to defaults and good fields stay", () => {
    const s = validateState({
      lastAc: true,
      lastPlace: "moon",
      heatBlocked: "yes",
      sensorFailures: -3,
      firedRules: ["a@2026-11-11", 5],
      override: { kind: "topup", target: 100, startedAt: "2026-11-11T08:00:00.000Z" },
    });
    expect(s.lastAc).toBe(true);
    expect(s.lastPlace).toBeNull();
    expect(s.heatBlocked).toBe(false);
    expect(s.sensorFailures).toBe(0);
    expect(s.firedRules).toEqual(["a@2026-11-11"]);
    expect(s.override).toEqual({
      kind: "topup",
      target: 100,
      step: null,
      startedAt: "2026-11-11T08:00:00.000Z",
      stepStartedAt: null,
      source: "user",
    });
    expect(validateState({ override: { kind: "bad", startedAt: "x" } }).override).toBeNull();
  });

  test("tripTopup is null by default and keeps a good value", () => {
    expect(validateState({}).tripTopup).toBeNull();
    expect(validateState({}).tripTopupNotified).toBeNull();
    const s = validateState({
      tripTopup: { id: "t1", until: "2026-11-11T13:50:00.000Z", extra: 1 },
      tripTopupNotified: "t1",
    });
    expect(s.tripTopup).toEqual({ id: "t1", until: "2026-11-11T13:50:00.000Z" });
    expect(s.tripTopupNotified).toBe("t1");
  });

  test("lastChargeWatts is null by default and keeps a finite value from 1 to 200", () => {
    expect(validateState({}).lastChargeWatts).toBeNull();
    expect(validateState({ lastChargeWatts: 8.9 }).lastChargeWatts).toBe(8.9);
    expect(validateState({ lastChargeWatts: 1 }).lastChargeWatts).toBe(1);
    expect(validateState({ lastChargeWatts: 200 }).lastChargeWatts).toBe(200);
  });

  test("a bad lastChargeWatts becomes null", () => {
    expect(validateState({ lastChargeWatts: 0.5 }).lastChargeWatts).toBeNull();
    expect(validateState({ lastChargeWatts: 201 }).lastChargeWatts).toBeNull();
    expect(validateState({ lastChargeWatts: -3 }).lastChargeWatts).toBeNull();
    expect(validateState({ lastChargeWatts: NaN }).lastChargeWatts).toBeNull();
    expect(validateState({ lastChargeWatts: "9" }).lastChargeWatts).toBeNull();
  });

  test("a bad tripTopup becomes null", () => {
    expect(validateState({ tripTopup: "t1" }).tripTopup).toBeNull();
    expect(validateState({ tripTopup: { id: "", until: "2026-11-11T13:50:00.000Z" } }).tripTopup).toBeNull();
    expect(validateState({ tripTopup: { id: "t1", until: "soon" } }).tripTopup).toBeNull();
    expect(validateState({ tripTopup: { id: "t1" } }).tripTopup).toBeNull();
    expect(validateState({ tripTopupNotified: 4 }).tripTopupNotified).toBeNull();
  });
});

describe("files", () => {
  const dirs: string[] = [];
  function tmpHome(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "chargeguard-test-"));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("configDir joins the home directory and .chargeguard", () => {
    expect(configDir("/home/x")).toBe(path.join("/home/x", ".chargeguard"));
    expect(configDir()).toBe(path.join(os.homedir(), ".chargeguard"));
  });

  test("missing files give the defaults", () => {
    const dir = configDir(tmpHome());
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    expect(loadState(dir)).toEqual(DEFAULT_STATE);
  });

  test("config round trip creates the directory with mode 0700", () => {
    const dir = configDir(tmpHome());
    const cfg = validateConfig({ limit: 70, places: { office: { routers: ["aa:bb:cc:dd:ee:01"] } } });
    saveConfig(dir, cfg);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(loadConfig(dir)).toEqual(cfg);
    expect(loadConfig(dir).limit).toBe(70);
  });

  test("state round trip", () => {
    const dir = configDir(tmpHome());
    const s = validateState({ lastAc: false, lastPlace: "home", firedRules: ["r@2026-11-11"] });
    saveState(dir, s);
    expect(loadState(dir)).toEqual(s);
  });

  test("save leaves no temporary file", () => {
    const dir = configDir(tmpHome());
    saveConfig(dir, DEFAULT_CONFIG);
    saveConfig(dir, DEFAULT_CONFIG);
    const names = fs.readdirSync(dir);
    expect(names).toEqual(["config.json"]);
  });

  test("corrupt JSON gives the defaults and keeps a .bad copy", () => {
    const dir = configDir(tmpHome());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{ not json");
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    expect(fs.readFileSync(file + ".bad", "utf8")).toBe("{ not json");

    const sfile = path.join(dir, "state.json");
    fs.writeFileSync(sfile, "[1,2");
    expect(loadState(dir)).toEqual(DEFAULT_STATE);
    expect(fs.existsSync(sfile + ".bad")).toBe(true);
  });

  test("JSON that is not an object counts as corrupt", () => {
    const dir = configDir(tmpHome());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "42");
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
    expect(fs.existsSync(file + ".bad")).toBe(true);
  });

  test("load clamps values from a hand-edited file", () => {
    const dir = configDir(tmpHome());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ limit: 5, sail: 50 }));
    const c = loadConfig(dir);
    expect(c.limit).toBe(10);
    expect(c.sail).toBe(20);
  });
});

describe("parseTrips", () => {
  const now = new Date("2026-11-12T08:00:00Z");
  const trip = {
    id: "a1", title: "Client meeting", start: "2026-11-12T10:00:00Z", location: "Jl. Sudirman 1",
    travelMin: 35, from: "home" as PlaceKind,
  };
  const file = (over: Record<string, unknown> = {}) => ({
    version: 1, computedAt: "2026-11-12T07:55:00Z", access: "granted", trips: [trip], ...over,
  });

  test("keeps the trips of a valid file", () => {
    const r = parseTrips(file(), now);
    expect(r.access).toBe("granted");
    expect(r.trips).toEqual([trip]);
  });
  test("keeps only the Trip fields", () => {
    const r = parseTrips(file({ trips: [{ ...trip, travelAt: "x", resolved: "y" }] }), now);
    expect(r.trips).toEqual([trip]);
  });
  test("accepts a null travel time", () => {
    expect(parseTrips(file({ trips: [{ ...trip, travelMin: null }] }), now).trips.length).toBe(1);
  });
  test("returns no trips for a stale file", () => {
    expect(parseTrips(file({ computedAt: "2026-11-12T07:00:00Z" }), now).trips).toEqual([]);
  });
  test("returns no trips when access is denied", () => {
    const r = parseTrips(file({ access: "denied" }), now);
    expect(r.access).toBe("denied");
    expect(r.trips).toEqual([]);
  });
  test("drops a bad trip and keeps the good one", () => {
    const bad = [
      { ...trip, id: 5 },
      { ...trip, start: "not a date" },
      { ...trip, travelMin: -1 },
      { ...trip, travelMin: Number.POSITIVE_INFINITY },
      { ...trip, from: "mars" },
      null,
    ];
    expect(parseTrips(file({ trips: [...bad, trip] }), now).trips).toEqual([trip]);
  });
  test("returns no trips for a missing or wrong shape", () => {
    expect(parseTrips(undefined, now)).toEqual({ access: null, trips: [] });
    expect(parseTrips("x", now).trips).toEqual([]);
    expect(parseTrips(file({ trips: "no" }), now).trips).toEqual([]);
  });
});
