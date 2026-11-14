import { describe, test, expect } from "bun:test";
import { DEFAULT_CONFIG, DEFAULT_STATE } from "../src/config";
import { baseTarget, decide, nextChange, officeWindow, resolvePlace, tripWindow } from "../src/policy";
import type { Config, Override, RuntimeState, ScheduleRule, Snapshot, Trip } from "../src/types";

const HOME = "9c:71:3a:40:db:9f";
const OFFICE = "aa:bb:cc:dd:ee:01";
const ELSEWHERE = "11:22:33:44:55:66";

function cfg(over: (c: Config) => void = () => {}): Config {
  const c: Config = structuredClone(DEFAULT_CONFIG);
  c.places.home.routers = [HOME];
  c.places.office.routers = [OFFICE];
  over(c);
  return c;
}

function snap(p: Partial<Snapshot> = {}): Snapshot {
  return {
    percent: 60,
    ac: true,
    charging: true,
    tempC: 30,
    clamshell: false,
    routerMac: HOME,
    gatewayIp: "192.168.100.1",
    adapterWatts: 70,
    healthPct: 100,
    cycleCount: 2,
    minutesToEmpty: null,
    minutesToFull: null,
    batteryWatts: 20,
    sleeping: false,
    ...p,
  };
}

function st(p: Partial<RuntimeState> = {}): RuntimeState {
  return { ...structuredClone(DEFAULT_STATE), lastAc: true, ...p };
}

function ov(p: Partial<Override> & Pick<Override, "kind">): Override {
  return {
    target: null,
    step: null,
    startedAt: new Date(2026, 10, 11, 9, 0).toISOString(),
    stepStartedAt: null,
    source: "user",
    ...p,
  };
}

/** 2026-11-11 is a Wednesday. */
function wed(h: number, m = 0): Date {
  return new Date(2026, 10, 11, h, m);
}
/** 2026-11-14 is a Saturday. */
function sat(h: number, m = 0): Date {
  return new Date(2026, 10, 14, h, m);
}

describe("places", () => {
  test("resolvePlace maps offline, home, office, and away", () => {
    const c = cfg();
    expect(resolvePlace(null, c)).toBe("offline");
    expect(resolvePlace(HOME, c)).toBe("home");
    expect(resolvePlace(OFFICE, c)).toBe("office");
    expect(resolvePlace(ELSEWHERE, c)).toBe("away");
  });

  test("resolvePlace uses a manual placeMode before the router", () => {
    const c = cfg((x) => {
      x.placeMode = "office";
    });
    expect(resolvePlace(ELSEWHERE, c)).toBe("office");
    expect(resolvePlace(HOME, c)).toBe("office");
    expect(resolvePlace(null, c)).toBe("office");
  });

  test("resolvePlace with placeMode auto keeps the router behavior", () => {
    const c = cfg((x) => {
      x.placeMode = "auto";
    });
    expect(resolvePlace(null, c)).toBe("offline");
    expect(resolvePlace(HOME, c)).toBe("home");
    expect(resolvePlace(OFFICE, c)).toBe("office");
    expect(resolvePlace(ELSEWHERE, c)).toBe("away");
  });

  test("resolvePlace accepts the short arp MAC form and upper case", () => {
    const c = cfg((x) => {
      x.places.home.routers = ["9c:71:3a:04:db:9f"];
    });
    expect(resolvePlace("9c:71:3a:4:db:9f", c)).toBe("home");
    expect(resolvePlace("9C:71:3A:04:DB:9F", c)).toBe("home");
  });

  test("baseTarget uses the place limit, the global limit, and the away limit", () => {
    const c = cfg((x) => {
      x.places.office.limit = 90;
    });
    expect(baseTarget("home", c)).toBe(80);
    expect(baseTarget("office", c)).toBe(90);
    expect(baseTarget("away", c)).toBe(100);
    expect(baseTarget("offline", c)).toBe(100);
  });
});

describe("basic targets", () => {
  test("home above the limit says it lowers to the limit", () => {
    const { decision } = decide(snap({ percent: 95, charging: false }), cfg(), st(), wed(12));
    expect(decision.mode).toBe("holding");
    expect(decision.nativeLimit).toBe(80);
    expect(decision.summary).toBe("Above 80%. macOS uses the battery down to 80%, then holds.");
  });

  test("home at 80% holds", () => {
    const { decision, state } = decide(snap({ percent: 80, charging: false }), cfg(), st(), wed(12));
    expect(decision.place).toBe("home");
    expect(decision.target).toBe(80);
    expect(decision.nativeLimit).toBe(80);
    expect(decision.mode).toBe("holding");
    expect(decision.adapter).toBe(true);
    expect(decision.summary).toBe("Holding at 80%. macOS stops charging here.");
    expect(decision.led).toBe("green");
    expect(state.sailing).toBe(true);
  });

  test("home below target charges", () => {
    const { decision } = decide(snap({ percent: 70 }), cfg(), st(), wed(12));
    expect(decision.mode).toBe("charging");
    expect(decision.summary).toBe("Charging to 80%.");
    expect(decision.led).toBe("orange");
  });

  test("home below target and not charging is sailing", () => {
    const { decision } = decide(snap({ percent: 78, charging: false }), cfg(), st(), wed(12));
    expect(decision.mode).toBe("sailing");
    expect(decision.summary).toBe("Not charging. macOS starts again below 80%.");
    expect(decision.led).toBe("green");
  });

  test("away charges to 100", () => {
    const { decision } = decide(snap({ percent: 50, routerMac: ELSEWHERE }), cfg(), st(), wed(12));
    expect(decision.place).toBe("away");
    expect(decision.target).toBe(100);
    expect(decision.nativeLimit).toBe(100);
    expect(decision.summary).toBe("Away from Home and Office. Charges to 100%.");
  });

  test("offline charges to 100", () => {
    const { decision } = decide(snap({ percent: 50, routerMac: null }), cfg(), st(), wed(12));
    expect(decision.place).toBe("offline");
    expect(decision.target).toBe(100);
    expect(decision.summary).toBe("No network. Charges to 100%.");
  });

  test("on battery the mode is unplugged", () => {
    const { decision } = decide(snap({ ac: false, charging: false }), cfg(), st({ lastAc: false }), wed(12));
    expect(decision.mode).toBe("unplugged");
    expect(decision.summary).toBe("On battery.");
    expect(decision.led).toBe("system");
  });
});

describe("office hours", () => {
  const office = { routerMac: OFFICE };

  test("before top-up the target is the limit", () => {
    const { decision } = decide(snap({ ...office, percent: 60 }), cfg(), st(), wed(15, 29));
    expect(decision.target).toBe(80);
    expect(decision.notify).toHaveLength(0);
  });

  test("at 15:30 the target is 100 and one notify is sent once per day", () => {
    const c = cfg();
    const first = decide(snap({ ...office, percent: 60 }), c, st(), wed(15, 30));
    expect(first.decision.target).toBe(100);
    expect(first.decision.mode).toBe("topup");
    expect(first.decision.reason).toBe("office-topup");
    expect(first.decision.summary).toBe("Charging to 100% before 17:00.");
    expect(first.decision.notify).toHaveLength(1);
    expect(first.decision.notify[0]?.event).toBe("officeTopupStart");
    expect(first.decision.notify[0]?.body).toBe("Office top-up started. Charges to 100% for 17:00.");
    expect(first.state.officeTopupNotified).toBe("2026-11-11");

    const second = decide(snap({ ...office, percent: 62 }), c, first.state, wed(15, 31));
    expect(second.decision.target).toBe(100);
    expect(second.decision.notify).toHaveLength(0);
  });

  test("before the grace end the target stays 100", () => {
    const { decision } = decide(snap({ ...office }), cfg(), st({ officeTopupNotified: "2026-11-11" }), wed(18, 59));
    expect(decision.target).toBe(100);
  });

  test("after the grace end the target is the limit", () => {
    const { decision } = decide(snap({ ...office, percent: 90 }), cfg(), st(), wed(19, 0));
    expect(decision.target).toBe(80);
  });

  test("on a weekend the target is the limit", () => {
    const c = cfg();
    const { decision } = decide(snap({ ...office, percent: 60 }), c, st(), sat(15, 30));
    expect(decision.target).toBe(80);
    const w = officeWindow(snap(office), c, sat(15, 30));
    expect(w.topupStart).toBeNull();
    expect(w.graceEnd).toBeNull();
    expect(w.tooSlow).toBe(false);
  });

  test("office hours do not change the target at home", () => {
    const { decision } = decide(snap({ percent: 60 }), cfg(), st(), wed(16));
    expect(decision.target).toBe(80);
  });

  test("a disabled office window does not apply", () => {
    const c = cfg((x) => {
      x.officeHours.enabled = false;
    });
    const { decision } = decide(snap({ ...office }), c, st(), wed(16));
    expect(decision.target).toBe(80);
  });

  test("officeWindow gives ISO times and an estimate", () => {
    const w = officeWindow(snap({ percent: 50, batteryWatts: 36 }), cfg(), wed(12));
    expect(w.topupStart).toBe(wed(15, 30).toISOString());
    expect(w.end).toBe(wed(17).toISOString());
    expect(w.graceEnd).toBe(wed(19).toISOString());
    expect(w.etaMin).toBe(60);
    expect(w.tooSlow).toBe(false);
  });

  test("officeWindow marks a slow charger", () => {
    const w = officeWindow(snap({ percent: 80, batteryWatts: null, adapterWatts: 7 }), cfg(), wed(12));
    expect(w.etaMin).toBe(412);
    expect(w.tooSlow).toBe(true);
    const none = officeWindow(snap({ batteryWatts: null, adapterWatts: null }), cfg(), wed(12));
    expect(none.etaMin).toBeNull();
    expect(none.tooSlow).toBe(false);
  });
});

describe("plug and unplug events", () => {
  test("plug at home", () => {
    const now = wed(12);
    const { decision, state } = decide(snap({ percent: 60 }), cfg(), st({ lastAc: false }), now);
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]).toEqual({
      event: "plug",
      title: "ChargeGuard",
      body: "Plugged in at Home. Charging stops at 80%.",
    });
    expect(state.lastPlugAt).toBe(now.toISOString());
    expect(state.lastAc).toBe(true);
    expect(state.lastPlace).toBe("home");
  });

  test("plug at office before top-up", () => {
    const { decision } = decide(snap({ routerMac: OFFICE }), cfg(), st({ lastAc: false }), wed(14));
    expect(decision.notify[0]?.body).toBe(
      "Plugged in at Office. Holds 80% until 15:30, then charges to 100% for 17:00.",
    );
  });

  test("plug during office top-up sends one text", () => {
    const { decision } = decide(snap({ routerMac: OFFICE }), cfg(), st({ lastAc: false }), wed(16));
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]?.body).toBe("Plugged in at Office. Charges to 100% before 17:00.");
  });

  test("plug at the office on a weekend uses the plain text", () => {
    const { decision } = decide(snap({ routerMac: OFFICE }), cfg(), st({ lastAc: false }), sat(14));
    expect(decision.notify[0]?.body).toBe("Plugged in at Office. Charging stops at 80%.");
  });

  test("plug away", () => {
    const { decision } = decide(snap({ routerMac: ELSEWHERE }), cfg(), st({ lastAc: false }), wed(12));
    expect(decision.notify[0]?.body).toBe("Plugged in away from Home and Office. Charges to 100%.");
  });

  test("unplug with and without time left", () => {
    const now = wed(12);
    const a = decide(
      snap({ ac: false, charging: false, percent: 80, minutesToEmpty: 360 }),
      cfg(),
      st({ lastAc: true }),
      now,
    );
    expect(a.decision.notify[0]?.event).toBe("unplug");
    expect(a.decision.notify[0]?.body).toBe("On battery at 80%. About 6 h left.");
    expect(a.state.lastUnplugAt).toBe(now.toISOString());

    const b = decide(snap({ ac: false, charging: false, percent: 80 }), cfg(), st({ lastAc: true }), now);
    expect(b.decision.notify[0]?.body).toBe("On battery at 80%.");

    const c = decide(
      snap({ ac: false, charging: false, percent: 80, minutesToEmpty: 90 }),
      cfg(),
      st({ lastAc: true }),
      now,
    );
    expect(c.decision.notify[0]?.body).toBe("On battery at 80%. About 1 h 30 min left.");
  });

  test("the first tick sends no plug or unplug notify", () => {
    const a = decide(snap(), cfg(), st({ lastAc: null }), wed(12));
    expect(a.decision.notify).toHaveLength(0);
    expect(a.state.lastAc).toBe(true);
    const b = decide(snap({ ac: false, charging: false }), cfg(), st({ lastAc: null }), wed(12));
    expect(b.decision.notify).toHaveLength(0);
    expect(b.state.lastAc).toBe(false);
  });

  test("an event is off when notifications[event] is false", () => {
    const c = cfg((x) => {
      x.notifications = { plug: false };
    });
    const { decision, state } = decide(snap(), c, st({ lastAc: false }), wed(12));
    expect(decision.notify).toHaveLength(0);
    expect(state.lastPlugAt).not.toBeNull();
  });
});

describe("overrides", () => {
  test("topup override sets the target and ends on unplug", () => {
    const c = cfg();
    const on = decide(snap({ percent: 60 }), c, st({ override: ov({ kind: "topup", target: 100 }) }), wed(12));
    expect(on.decision.target).toBe(100);
    expect(on.decision.mode).toBe("topup");
    expect(on.decision.reason).toBe("override-topup");
    expect(on.state.override?.kind).toBe("topup");

    const off = decide(
      snap({ ac: false, charging: false }),
      c,
      st({ override: ov({ kind: "topup", target: 100 }) }),
      wed(12),
    );
    expect(off.state.override).toBeNull();
    expect(off.decision.mode).toBe("unplugged");
    expect(off.decision.preventSleep).toBe(false);
  });

  test("pause override leaves macOS in charge", () => {
    const { decision } = decide(snap({ percent: 70 }), cfg(), st({ override: ov({ kind: "pause" }) }), wed(12));
    expect(decision.nativeLimit).toBe(100);
    expect(decision.adapter).toBe(true);
    expect(decision.led).toBe("system");
    expect(decision.mode).toBe("paused");
    expect(decision.reason).toBe("paused");
    expect(decision.summary).toBe("ChargeGuard is paused. macOS charges normally.");
  });

  test("discharge turns the adapter off while above the target", () => {
    const { decision, state } = decide(
      snap({ percent: 90, charging: false }),
      cfg(),
      st({ override: ov({ kind: "discharge", target: 50 }) }),
      wed(12),
    );
    expect(decision.adapter).toBe(false);
    expect(decision.nativeLimit).toBe(50);
    expect(decision.mode).toBe("discharging");
    expect(decision.reason).toBe("discharge");
    expect(decision.led).toBe("off");
    expect(decision.preventSleep).toBe(true);
    expect(state.override?.kind).toBe("discharge");
  });

  test("discharge in clamshell waits unless the option is on", () => {
    const s = () => st({ override: ov({ kind: "discharge", target: 50 }) });
    const paused = decide(snap({ percent: 90, clamshell: true }), cfg(), s(), wed(12));
    expect(paused.decision.adapter).toBe(true);
    expect(paused.decision.nativeLimit).toBe(50);
    expect(paused.decision.mode).toBe("discharging");
    expect(paused.decision.reason).toBe("discharge-clamshell-paused");
    expect(paused.decision.summary).toContain("lid opens");

    const c = cfg((x) => {
      x.dischargeInClamshell = true;
    });
    const go = decide(snap({ percent: 90, clamshell: true }), c, s(), wed(12));
    expect(go.decision.adapter).toBe(false);
    expect(go.decision.reason).toBe("discharge");
  });

  test("discharge ends at the target and sends one notify", () => {
    const { decision, state } = decide(
      snap({ percent: 50, charging: false }),
      cfg(),
      st({ override: ov({ kind: "discharge", target: 50 }) }),
      wed(12),
    );
    expect(state.override).toBeNull();
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]?.event).toBe("dischargeDone");
    expect(decision.notify[0]?.body).toBe("Discharge is complete at 50%.");
    expect(decision.adapter).toBe(true);
    expect(decision.target).toBe(80);
  });

  test("discharge stays active while unplugged", () => {
    const { decision, state } = decide(
      snap({ ac: false, charging: false, percent: 90 }),
      cfg(),
      st({ lastAc: false, override: ov({ kind: "discharge", target: 50 }) }),
      wed(12),
    );
    expect(state.override?.kind).toBe("discharge");
    expect(decision.mode).toBe("unplugged");
  });
});

describe("calibration", () => {
  const cal = (step: Override["step"], stepStartedAt: Date | null = null) =>
    st({ override: ov({ kind: "calibrate", step, stepStartedAt: stepStartedAt ? stepStartedAt.toISOString() : null }) });

  test("drain turns the adapter off", () => {
    const { decision, state } = decide(snap({ percent: 40, charging: false }), cfg(), cal("drain"), wed(12));
    expect(decision.adapter).toBe(false);
    expect(decision.mode).toBe("calibrating");
    expect(state.override?.step).toBe("drain");
    expect(decision.preventSleep).toBe(true);
  });

  test("drain moves to fill at 15%", () => {
    const now = wed(12);
    const { decision, state } = decide(snap({ percent: 15, charging: false }), cfg(), cal("drain"), now);
    expect(state.override?.step).toBe("fill");
    expect(state.override?.stepStartedAt).toBe(now.toISOString());
    expect(decision.adapter).toBe(true);
    expect(decision.nativeLimit).toBe(100);
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]?.event).toBe("calibrationStep");
  });

  test("fill charges to 100 and then moves to hold", () => {
    const mid = decide(snap({ percent: 50 }), cfg(), cal("fill"), wed(12));
    expect(mid.decision.adapter).toBe(true);
    expect(mid.decision.nativeLimit).toBe(100);
    expect(mid.state.override?.step).toBe("fill");

    const now = wed(13);
    const full = decide(snap({ percent: 100, charging: false }), cfg(), cal("fill"), now);
    expect(full.state.override?.step).toBe("hold");
    expect(full.state.override?.stepStartedAt).toBe(now.toISOString());
    expect(full.decision.notify).toHaveLength(1);
  });

  test("hold lasts 60 minutes and then moves to settle", () => {
    const started = wed(14, 30);
    const early = decide(snap({ percent: 100, charging: false }), cfg(), cal("hold", started), wed(15, 29));
    expect(early.state.override?.step).toBe("hold");
    expect(early.decision.nativeLimit).toBe(100);
    expect(early.decision.adapter).toBe(true);

    const done = decide(snap({ percent: 100, charging: false }), cfg(), cal("hold", started), wed(15, 30));
    expect(done.state.override?.step).toBe("settle");
    expect(done.decision.adapter).toBe(false);
    expect(done.decision.nativeLimit).toBe(80);
    expect(done.decision.notify[0]?.event).toBe("calibrationStep");
  });

  test("settle ends the calibration at the base target", () => {
    const up = decide(snap({ percent: 90, charging: false }), cfg(), cal("settle", wed(15, 30)), wed(16));
    expect(up.decision.adapter).toBe(false);
    expect(up.decision.mode).toBe("calibrating");

    const end = decide(snap({ percent: 80, charging: false }), cfg(), cal("settle", wed(15, 30)), wed(17));
    expect(end.state.override).toBeNull();
    expect(end.decision.reason).toBe("calibration-done");
    expect(end.decision.adapter).toBe(true);
    expect(end.decision.notify).toHaveLength(1);
    expect(end.decision.notify[0]?.body).toBe("Calibration is complete.");
  });

  test("calibration needs the charger", () => {
    const { decision, state } = decide(
      snap({ ac: false, charging: false, percent: 40 }),
      cfg(),
      { ...cal("drain"), lastAc: false },
      wed(12),
    );
    expect(state.override?.kind).toBe("calibrate");
    expect(decision.mode).toBe("unplugged");
    expect(decision.summary).toBe("Connect the charger to continue calibration.");
  });
});

describe("heat", () => {
  test("heat blocks charging at the current percent", () => {
    const { decision, state } = decide(snap({ percent: 70, tempC: 36 }), cfg(), st(), wed(12));
    expect(state.heatBlocked).toBe(true);
    expect(decision.nativeLimit).toBe(70);
    expect(decision.mode).toBe("heat");
    expect(decision.reason).toBe("heat");
    expect(decision.led).toBe("system");
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]?.event).toBe("heatPause");
    expect(decision.notify[0]?.body).toBe(
      "Battery is hot (36 °C). Charging stops until it cools to 32 °C.",
    );
  });

  test("heat limit never goes above the target", () => {
    const { decision } = decide(snap({ percent: 90, tempC: 36 }), cfg(), st(), wed(12));
    expect(decision.nativeLimit).toBe(80);
  });

  test("heat has hysteresis and resumes at the resume temperature", () => {
    const c = cfg();
    const still = decide(snap({ percent: 70, tempC: 34 }), c, st({ heatBlocked: true }), wed(12));
    expect(still.state.heatBlocked).toBe(true);
    expect(still.decision.mode).toBe("heat");
    expect(still.decision.notify).toHaveLength(0);

    const back = decide(snap({ percent: 70, tempC: 32 }), c, st({ heatBlocked: true }), wed(12));
    expect(back.state.heatBlocked).toBe(false);
    expect(back.decision.mode).toBe("charging");
    expect(back.decision.nativeLimit).toBe(80);
  });

  test("heat does not stop a discharge", () => {
    const { decision } = decide(
      snap({ percent: 90, tempC: 40 }),
      cfg(),
      st({ override: ov({ kind: "discharge", target: 50 }) }),
      wed(12),
    );
    expect(decision.mode).toBe("discharging");
    expect(decision.adapter).toBe(false);
  });

  test("heat protection off keeps charging", () => {
    const c = cfg((x) => {
      x.heat.enabled = false;
    });
    const { decision, state } = decide(snap({ percent: 70, tempC: 45 }), c, st(), wed(12));
    expect(state.heatBlocked).toBe(false);
    expect(decision.mode).toBe("charging");
  });
});

describe("safety and side outputs", () => {
  test("R9 forces the adapter on below 10%", () => {
    const { decision } = decide(
      snap({ percent: 8, charging: false }),
      cfg(),
      st({ override: ov({ kind: "discharge", target: 5 }) }),
      wed(12),
    );
    expect(decision.adapter).toBe(true);
  });

  test("lowPower follows the config", () => {
    const on = cfg((x) => {
      x.lowPower = { enabled: true, belowPct: 20 };
    });
    const battery = (p: number) => decide(snap({ ac: false, charging: false, percent: p }), on, st({ lastAc: false }), wed(12));
    expect(battery(15).decision.lowPower).toBe(true);
    expect(battery(50).decision.lowPower).toBeNull();
    expect(decide(snap(), on, st(), wed(12)).decision.lowPower).toBe(false);
    expect(
      decide(snap({ ac: false, charging: false, percent: 15 }), cfg(), st({ lastAc: false }), wed(12)).decision.lowPower,
    ).toBeNull();
  });

  test("preventSleep follows overrides and sleepControl", () => {
    const withTopup = st({ override: ov({ kind: "topup", target: 100 }) });
    expect(decide(snap(), cfg(), withTopup, wed(12)).decision.preventSleep).toBe(true);
    expect(decide(snap(), cfg(), st(), wed(12)).decision.preventSleep).toBe(false);
    const off = cfg((x) => {
      x.sleepControl = false;
    });
    expect(decide(snap(), off, withTopup, wed(12)).decision.preventSleep).toBe(false);
  });

  test("led mapping", () => {
    const c = cfg();
    expect(decide(snap({ percent: 60 }), c, st(), wed(12)).decision.led).toBe("orange");
    expect(decide(snap({ percent: 80, charging: false }), c, st(), wed(12)).decision.led).toBe("green");
    expect(decide(snap({ ac: false, charging: false }), c, st({ lastAc: false }), wed(12)).decision.led).toBe("system");
    expect(decide(snap({ tempC: 40 }), c, st(), wed(12)).decision.led).toBe("system");
    const off = cfg((x) => {
      x.magsafeLed = false;
    });
    expect(decide(snap({ percent: 60 }), off, st(), wed(12)).decision.led).toBe("system");
  });
});

describe("schedule", () => {
  const rule = (p: Partial<ScheduleRule> = {}): ScheduleRule => ({
    id: "r1",
    enabled: true,
    days: [3],
    time: "15:30",
    action: { kind: "topup" },
    ...p,
  });

  test("a rule fires once inside its 10 minute window", () => {
    const c = cfg((x) => {
      x.schedule = [rule()];
    });
    const first = decide(snap({ percent: 60 }), c, st(), wed(15, 35));
    expect(first.state.override?.kind).toBe("topup");
    expect(first.state.override?.target).toBe(100);
    expect(first.state.override?.source).toBe("schedule");
    expect(first.state.firedRules).toEqual(["r1@2026-11-11"]);
    expect(first.decision.mode).toBe("topup");

    const second = decide(snap({ percent: 60 }), c, { ...first.state, override: null }, wed(15, 36));
    expect(second.state.override).toBeNull();
    expect(second.decision.target).toBe(80);
  });

  test("a rule does not fire outside the window", () => {
    const c = cfg((x) => {
      x.schedule = [rule()];
    });
    expect(decide(snap(), c, st(), wed(15, 29)).state.override).toBeNull();
    expect(decide(snap(), c, st(), wed(15, 40)).state.override).toBeNull();
  });

  test("a rule for another weekday or a disabled rule does not fire", () => {
    const c = cfg((x) => {
      x.schedule = [rule({ days: [1] }), rule({ id: "r2", enabled: false })];
    });
    expect(decide(snap(), c, st(), wed(15, 35)).state.override).toBeNull();
  });

  test("limit and discharge and calibrate rules start the right override", () => {
    const run = (action: ScheduleRule["action"]) =>
      decide(
        snap({ percent: 60 }),
        cfg((x) => {
          x.schedule = [rule({ action })];
        }),
        st(),
        wed(15, 32),
      ).state.override;
    expect(run({ kind: "limit", value: 90 })).toMatchObject({ kind: "topup", target: 90 });
    expect(run({ kind: "discharge", value: 40 })).toMatchObject({ kind: "discharge", target: 40 });
    expect(run({ kind: "calibrate" })).toMatchObject({ kind: "calibrate", step: "drain" });
  });

  test("a user override is not replaced by a rule", () => {
    const c = cfg((x) => {
      x.schedule = [rule({ action: { kind: "discharge", value: 40 } })];
    });
    const { state } = decide(snap(), c, st({ override: ov({ kind: "topup", target: 100 }) }), wed(15, 35));
    expect(state.override?.kind).toBe("topup");
    expect(state.override?.source).toBe("user");
  });

  test("fired rules from other days are dropped", () => {
    const { state } = decide(snap(), cfg(), st({ firedRules: ["r1@2026-11-10", "r2@2026-11-11"] }), wed(12));
    expect(state.firedRules).toEqual(["r2@2026-11-11"]);
  });
});

describe("nextChange", () => {
  test("office before top-up", () => {
    const text = nextChange(snap({ routerMac: OFFICE, percent: 50, batteryWatts: 36 }), cfg(), st(), wed(14));
    expect(text).toBe("Top-up starts 15:30. Full by about 17:00.");
  });

  test("office before top-up with a slow charger", () => {
    const text = nextChange(
      snap({ routerMac: OFFICE, percent: 50, batteryWatts: null, adapterWatts: 7 }),
      cfg(),
      st(),
      wed(14),
    );
    expect(text).toBe("Top-up starts 15:30. This charger is slow; it can miss 17:00.");
  });

  test("office during top-up", () => {
    const text = nextChange(snap({ routerMac: OFFICE, percent: 50, batteryWatts: 36 }), cfg(), st(), wed(16));
    expect(text).toBe("Full by about 17:00.");
  });

  test("home has no next change unless a rule is later today", () => {
    expect(nextChange(snap(), cfg(), st(), wed(12))).toBeNull();
    const c = cfg((x) => {
      x.schedule = [{ id: "r1", enabled: true, days: [3], time: "18:00", action: { kind: "topup" } }];
    });
    expect(nextChange(snap(), c, st(), wed(12))).toBe("Schedule: top-up at 18:00.");
    expect(nextChange(snap(), c, st(), wed(19))).toBeNull();
  });
});

describe("calendar trips", () => {
  // Percent 50 and 36 W give an ETA of 60 min. The charge time is 72 min with the 1.2 margin.
  // Meeting 14:00, 30 min drive, 10 min buffer: leave 13:20, top-up starts 12:08.
  const slow = { percent: 50, batteryWatts: 36 };
  const calCfg = (over: (c: Config) => void = () => {}): Config =>
    cfg((c) => {
      c.calendar.enabled = true;
      over(c);
    });
  const trip = (p: Partial<Trip> = {}): Trip => ({
    id: "t1",
    title: "Client visit",
    start: wed(14).toISOString(),
    location: "Jl. Sudirman 1",
    travelMin: 30,
    from: "home",
    ...p,
  });

  test("tripWindow gives the leave time, the top-up start, and the charge time", () => {
    const w = tripWindow(snap(slow), calCfg(), [trip()], wed(12));
    expect(w).not.toBeNull();
    expect(w?.id).toBe("t1");
    expect(w?.title).toBe("Client visit");
    expect(w?.location).toBe("Jl. Sudirman 1");
    expect(w?.start).toBe(wed(14).toISOString());
    expect(w?.leaveAt).toBe(wed(13, 20).toISOString());
    expect(w?.topupStart).toBe(wed(12, 8).toISOString());
    expect(w?.travelMin).toBe(30);
    expect(w?.travelEstimated).toBe(false);
    expect(w?.chargeMin).toBe(72);
    expect(w?.tooLate).toBe(false);
  });

  test("a trip below minTravelMin gives no window and the target stays 80", () => {
    const near = trip({ travelMin: 5 });
    expect(tripWindow(snap(slow), calCfg(), [near], wed(12))).toBeNull();
    const { decision, state } = decide(snap(slow), calCfg(), st(), wed(13), { trips: [near] });
    expect(decision.target).toBe(80);
    expect(state.tripTopup).toBeNull();
    expect(nextChange(snap(slow), calCfg(), st(), wed(11), [near])).toBeNull();
  });

  test("a trip at minTravelMin gives a window", () => {
    expect(tripWindow(snap(slow), calCfg(), [trip({ travelMin: 10 })], wed(12))?.travelMin).toBe(10);
    expect(tripWindow(snap(slow), calCfg(), [trip({ travelMin: 9 })], wed(12))).toBeNull();
  });

  test("minTravelMin does not apply to a trip with no estimate", () => {
    const c = calCfg((x) => {
      x.calendar.minTravelMin = 60;
    });
    expect(tripWindow(snap(slow), c, [trip({ travelMin: null })], wed(12))?.travelEstimated).toBe(true);
  });

  test("a held battery uses the learned charge power for the top-up start", () => {
    // Hold at 80%. Live power is 0. Charger 30 W. Learned power 8.9 W. Meeting 09:00, drive 25 min, buffer 10 min.
    const t = trip({ start: wed(9).toISOString(), travelMin: 25 });
    const held = snap({ percent: 80, charging: false, batteryWatts: 0, adapterWatts: 30 });
    const w = tripWindow(held, calCfg(), [t], wed(5), 8.9);
    expect(w?.leaveAt).toBe(wed(8, 25).toISOString());
    expect(w?.chargeMin).toBe(117);
    expect(w?.topupStart).toBe(wed(6, 28).toISOString());
    const before = decide(held, calCfg(), st({ lastChargeWatts: 8.9 }), wed(6, 27), { trips: [t] });
    expect(before.decision.target).toBe(80);
    const at = decide(held, calCfg(), st({ lastChargeWatts: 8.9 }), wed(6, 28), { trips: [t] });
    expect(at.decision.target).toBe(100);
    expect(nextChange(held, calCfg(), st({ lastChargeWatts: 8.9 }), wed(5), [t])).toBe(
      "Meeting Client visit at 09:00. Leave 08:25, 25 min drive. Top-up starts 06:28.",
    );
  });

  test("without a learned charge power the charger power gives the estimate", () => {
    const t = trip({ start: wed(9).toISOString(), travelMin: 25 });
    const held = snap({ percent: 80, charging: false, batteryWatts: 0, adapterWatts: 30 });
    const w = tripWindow(held, calCfg(), [t], wed(5));
    // 30 W * 0.3 = 9 W. 14.4 Wh / 9 W = 96 min. With the 1.2 margin: 116 min.
    expect(w?.chargeMin).toBe(116);
    expect(w?.topupStart).toBe(wed(6, 29).toISOString());
  });

  test("the live charge power wins over the learned power", () => {
    const t = trip({ start: wed(9).toISOString(), travelMin: 25 });
    const live = snap({ percent: 80, charging: true, batteryWatts: 36, adapterWatts: 30 });
    expect(tripWindow(live, calCfg(), [t], wed(5), 8.9)?.chargeMin).toBe(29);
  });

  test("decide learns the charge power while it charges and keeps it while it holds", () => {
    const c = calCfg();
    const first = decide(snap({ percent: 50, batteryWatts: 10 }), c, st(), wed(12));
    expect(first.state.lastChargeWatts).toBe(10);
    const second = decide(snap({ percent: 51, batteryWatts: 20 }), c, first.state, wed(12, 1));
    expect(second.state.lastChargeWatts).toBeCloseTo(13, 6);
    const held = decide(snap({ percent: 80, charging: false, batteryWatts: 0 }), c, second.state, wed(12, 2));
    expect(held.state.lastChargeWatts).toBeCloseTo(13, 6);
    const low = decide(snap({ percent: 60, batteryWatts: 0.5 }), c, second.state, wed(12, 3));
    expect(low.state.lastChargeWatts).toBeCloseTo(13, 6);
    const battery = decide(snap({ ac: false, charging: false, batteryWatts: -8 }), c, st({ lastChargeWatts: 9 }), wed(12));
    expect(battery.state.lastChargeWatts).toBe(9);
  });

  test("tripWindow is null when the calendar is off or the list is empty", () => {
    expect(tripWindow(snap(slow), cfg(), [trip()], wed(12))).toBeNull();
    expect(tripWindow(snap(slow), calCfg(), [], wed(12))).toBeNull();
  });

  test("tripWindow picks the earliest trip and skips a trip that is past its grace time", () => {
    const trips = [
      trip({ id: "late", start: wed(18).toISOString() }),
      trip({ id: "past", start: wed(9).toISOString() }),
      trip({ id: "soon", start: wed(15).toISOString() }),
    ];
    expect(tripWindow(snap(slow), calCfg(), trips, wed(12))?.id).toBe("soon");
    // "past" leaves at 08:20. Its grace time ends at 08:50.
    expect(tripWindow(snap(slow), calCfg(), trips, wed(8, 49))?.id).toBe("past");
  });

  test("the target is 80 at 12:07 and 100 at 12:08", () => {
    const c = calCfg();
    const before = decide(snap(slow), c, st(), wed(12, 7), { trips: [trip()] });
    expect(before.decision.target).toBe(80);
    expect(before.decision.reason).toBe("limit");
    expect(before.state.tripTopup).toBeNull();

    const at = decide(snap(slow), c, st(), wed(12, 8), { trips: [trip()] });
    expect(at.decision.target).toBe(100);
    expect(at.decision.nativeLimit).toBe(100);
    expect(at.decision.mode).toBe("topup");
    expect(at.decision.reason).toBe("trip-topup");
    expect(at.decision.led).toBe("orange");
    expect(at.decision.summary).toBe("Charging to 100% before you leave at 13:20 for Client visit.");
    expect(at.state.tripTopup).toEqual({ id: "t1", until: wed(13, 50).toISOString() });
  });

  test("the start text is sent once for each trip", () => {
    const c = calCfg();
    const first = decide(snap(slow), c, st(), wed(12, 8), { trips: [trip()] });
    expect(first.decision.notify).toHaveLength(1);
    expect(first.decision.notify[0]?.event).toBe("tripTopupStart");
    expect(first.decision.notify[0]?.body).toBe(
      "Trip top-up started. Charges to 100% before you leave at 13:20 for Client visit.",
    );
    expect(first.state.tripTopupNotified).toBe("t1");

    const second = decide(snap(slow), c, first.state, wed(12, 9), { trips: [trip()] });
    expect(second.decision.target).toBe(100);
    expect(second.decision.notify).toHaveLength(0);
  });

  test("the start text can be turned off", () => {
    const c = calCfg((x) => {
      x.notifications = { tripTopupStart: false };
    });
    const { decision } = decide(snap(slow), c, st(), wed(12, 8), { trips: [trip()] });
    expect(decision.target).toBe(100);
    expect(decision.notify).toHaveLength(0);
  });

  test("a plug event during the top-up sends one text", () => {
    const { decision, state } = decide(snap(slow), calCfg(), st({ lastAc: false }), wed(12, 30), { trips: [trip()] });
    expect(decision.notify).toHaveLength(1);
    expect(decision.notify[0]?.event).toBe("plug");
    expect(decision.notify[0]?.body).toBe(
      "Plugged in at Home. Charges to 100% before you leave at 13:20 for Client visit.",
    );
    expect(state.tripTopupNotified).toBe("t1");
  });

  test("the latch keeps the target at 100 after the ETA drops", () => {
    const c = calCfg();
    const first = decide(snap(slow), c, st(), wed(12, 8), { trips: [trip()] });
    expect(first.decision.target).toBe(100);
    // At 95% the ETA is 6 min. The new top-up start is 13:12. Without the latch the target would be 80.
    const w = tripWindow(snap({ percent: 95, batteryWatts: 36 }), c, [trip()], wed(12, 20));
    expect(w?.topupStart).toBe(wed(13, 12).toISOString());
    const later = decide(snap({ percent: 95, batteryWatts: 36 }), c, first.state, wed(12, 20), { trips: [trip()] });
    expect(later.decision.target).toBe(100);
    expect(later.decision.reason).toBe("trip-topup");
    expect(later.state.tripTopup?.id).toBe("t1");
  });

  test("the latch ends at the grace time", () => {
    const c = calCfg();
    const latch = st({ tripTopup: { id: "t1", until: wed(13, 50).toISOString() } });
    const on = decide(snap(slow), c, latch, wed(13, 49), { trips: [trip()] });
    expect(on.decision.target).toBe(100);
    const off = decide(snap(slow), c, latch, wed(13, 50), { trips: [trip()] });
    expect(off.decision.target).toBe(80);
    expect(off.state.tripTopup).toBeNull();
  });

  test("the latch stays after an unplug", () => {
    const latch = st({ tripTopup: { id: "t1", until: wed(13, 50).toISOString() } });
    const { decision, state } = decide(snap({ ...slow, ac: false, charging: false }), calCfg(), latch, wed(12, 30), {
      trips: [trip()],
    });
    expect(decision.mode).toBe("unplugged");
    expect(state.tripTopup).toEqual({ id: "t1", until: wed(13, 50).toISOString() });
  });

  test("travelMin null uses the fallback of 45 min", () => {
    const t = trip({ travelMin: null });
    const w = tripWindow(snap(slow), calCfg(), [t], wed(11));
    expect(w?.travelMin).toBe(45);
    expect(w?.travelEstimated).toBe(true);
    expect(w?.leaveAt).toBe(wed(13, 5).toISOString());
    expect(w?.topupStart).toBe(wed(11, 53).toISOString());
    expect(nextChange(snap(slow), calCfg(), st(), wed(11), [t])).toBe(
      "Meeting Client visit at 14:00. Leave 13:05, about 45 min drive. Top-up starts 11:53.",
    );
  });

  test("a top-up start in the past sets tooLate and the target is 100 at once", () => {
    const c = calCfg();
    const w = tripWindow(snap(slow), c, [trip()], wed(13));
    expect(w?.tooLate).toBe(true);
    const { decision } = decide(snap(slow), c, st(), wed(13), { trips: [trip()] });
    expect(decision.target).toBe(100);
    expect(decision.reason).toBe("trip-topup");
  });

  test("tooLate is false when the battery is full", () => {
    const w = tripWindow(snap({ percent: 100, charging: false, batteryWatts: null }), calCfg(), [trip()], wed(13));
    expect(w?.tooLate).toBe(false);
  });

  test("a pause override wins and keeps the latch", () => {
    const latch = st({
      override: ov({ kind: "pause" }),
      tripTopup: { id: "t1", until: wed(13, 50).toISOString() },
    });
    const { decision, state } = decide(snap(slow), calCfg(), latch, wed(12, 30), { trips: [trip()] });
    expect(decision.mode).toBe("paused");
    expect(decision.reason).toBe("paused");
    expect(decision.summary).toBe("ChargeGuard is paused. macOS charges normally.");
    expect(decision.nativeLimit).toBe(100);
    expect(state.override?.kind).toBe("pause");
  });

  test("a discharge override wins over the trip top-up", () => {
    const { decision } = decide(
      snap({ percent: 90, charging: false, batteryWatts: 36 }),
      calCfg(),
      st({ override: ov({ kind: "discharge", target: 50 }) }),
      wed(13),
      { trips: [trip()] },
    );
    expect(decision.mode).toBe("discharging");
    expect(decision.reason).toBe("discharge");
    expect(decision.adapter).toBe(false);
  });

  test("heat wins over the trip top-up", () => {
    const { decision } = decide(snap({ ...slow, tempC: 40 }), calCfg(), st(), wed(12, 30), { trips: [trip()] });
    expect(decision.mode).toBe("heat");
    expect(decision.reason).toBe("heat");
    expect(decision.nativeLimit).toBe(50);
  });

  test("a removed trip clears the latch and the target returns to the base", () => {
    const latch = st({ tripTopup: { id: "t1", until: wed(13, 50).toISOString() } });
    const { decision, state } = decide(snap(slow), calCfg(), latch, wed(12, 30), { trips: [] });
    expect(state.tripTopup).toBeNull();
    expect(decision.target).toBe(80);
    expect(decision.reason).toBe("limit");
  });

  test("a call without ctx works and ignores trips", () => {
    const latch = st({ tripTopup: { id: "t1", until: wed(13, 50).toISOString() } });
    const { decision, state } = decide(snap(slow), calCfg(), latch, wed(12, 30));
    expect(state.tripTopup).toBeNull();
    expect(decision.target).toBe(80);
  });

  test("with the calendar off the window is null and the target is the limit", () => {
    const { decision, state } = decide(snap(slow), cfg(), st(), wed(12, 30), { trips: [trip()] });
    expect(decision.target).toBe(80);
    expect(state.tripTopup).toBeNull();
  });

  test("with the calendar off a latch from before is cleared", () => {
    const latch = st({ tripTopup: { id: "t1", until: wed(13, 50).toISOString() } });
    const { decision, state } = decide(snap(slow), cfg(), latch, wed(12, 30), { trips: [trip()] });
    expect(state.tripTopup).toBeNull();
    expect(decision.target).toBe(80);
  });

  test("the trip top-up applies away from home and office", () => {
    const { decision } = decide(snap({ ...slow, routerMac: ELSEWHERE }), calCfg(), st(), wed(12, 30), {
      trips: [trip({ from: "away" })],
    });
    expect(decision.target).toBe(100);
    expect(decision.reason).toBe("trip-topup");
  });

  test("nextChange before the top-up shows the meeting, the leave time, and the top-up start", () => {
    expect(nextChange(snap(slow), calCfg(), st(), wed(11), [trip()])).toBe(
      "Meeting Client visit at 14:00. Leave 13:20, 30 min drive. Top-up starts 12:08.",
    );
  });

  test("nextChange after the top-up start shows the full time and the leave time", () => {
    expect(nextChange(snap(slow), calCfg(), st(), wed(12, 30), [trip()])).toBe(
      "Full by about 13:30. Leave 13:20 for Client visit.",
    );
  });

  test("nextChange shows the trip before the office end and the office text after it", () => {
    const office = snap({ routerMac: OFFICE, ...slow });
    // Leave 13:20 is before the office end at 17:00.
    expect(nextChange(office, calCfg(), st(), wed(11), [trip()])).toBe(
      "Meeting Client visit at 14:00. Leave 13:20, 30 min drive. Top-up starts 12:08.",
    );
    // Leave 19:20 is after the office end at 17:00.
    const late = trip({ start: wed(20).toISOString() });
    expect(nextChange(office, calCfg(), st(), wed(14), [late])).toBe("Top-up starts 15:30. Full by about 17:00.");
  });

  test("nextChange without trips or with the calendar off keeps the old text", () => {
    const office = snap({ routerMac: OFFICE, ...slow });
    expect(nextChange(office, calCfg(), st(), wed(14), [])).toBe("Top-up starts 15:30. Full by about 17:00.");
    expect(nextChange(office, cfg(), st(), wed(14), [trip()])).toBe("Top-up starts 15:30. Full by about 17:00.");
  });
});
