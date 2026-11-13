// ChargeGuard policy. Pure functions. No I/O. No Date.now().
// The daemon gives the time in the `now` argument. Local time uses the local fields of that Date.

import { formatClock, normalizeMac, parseClock } from "./config";
import type {
  Config,
  DecideFn,
  Led,
  Mode,
  NotifyEvent,
  NotifyMessage,
  OfficeWindow,
  Override,
  PlaceKind,
  RuntimeState,
  Snapshot,
  Trip,
  TripWindow,
} from "./types";

const BATTERY_WH = 72;
// Share of the charger power that reaches the battery when no other power value exists.
// The real value measured on a 30 W charger was 8.9 W. An early start is safer than a late one.
const ADAPTER_CHARGE_FACTOR = 0.3;
const SCHEDULE_WINDOW_MIN = 10;
const CALIBRATION_HOLD_MIN = 60;
const CALIBRATION_DRAIN_PCT = 15;
const MIN_NATIVE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function localDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local date at midnight plus `min` minutes. A value outside 0..1439 moves to the next or last day. */
function atMinutes(now: Date, min: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, min, 0, 0);
}

function clockOf(d: Date): string {
  return formatClock(d.getHours() * 60 + d.getMinutes());
}

function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

/** Find the place. A manual placeMode wins over the router, also when there is no network. */
export function resolvePlace(routerMac: string | null, cfg: Config): PlaceKind {
  if (cfg.placeMode !== "auto") return cfg.placeMode;
  if (routerMac === null) return "offline";
  const mac = normalizeMac(routerMac);
  if (mac === null) return "away";
  const has = (list: string[]): boolean => list.some((r) => normalizeMac(r) === mac);
  if (has(cfg.places.home.routers)) return "home";
  if (has(cfg.places.office.routers)) return "office";
  return "away";
}

export function baseTarget(place: PlaceKind, cfg: Config): number {
  if (place === "home" || place === "office") return cfg.places[place].limit ?? cfg.limit;
  return cfg.awayLimit;
}

// ---------------------------------------------------------------------------
// Office window
// ---------------------------------------------------------------------------

/**
 * Minutes to 100%. The power comes from the first source that exists:
 * the live battery power while charging, the learned charge power, then 30% of the charger power.
 */
function rawMinutesToFull(snap: Snapshot, learnedWatts: number | null): number | null {
  let watts: number | null = null;
  if (snap.charging && snap.batteryWatts !== null && snap.batteryWatts >= 1) {
    watts = snap.batteryWatts;
  } else if (learnedWatts !== null && learnedWatts >= 1) {
    watts = learnedWatts;
  } else if (snap.adapterWatts !== null && snap.adapterWatts > 0) {
    watts = Math.max(1, snap.adapterWatts * ADAPTER_CHARGE_FACTOR);
  }
  if (watts === null) return null;
  if (snap.percent >= 100) return 0;
  const wh = ((100 - snap.percent) / 100) * BATTERY_WH;
  return (wh / watts) * 60;
}

/** Whole minutes to 100%, rounded up. null if no power source is known. */
function estimateMinutesToFull(snap: Snapshot, learnedWatts: number | null = null): number | null {
  const raw = rawMinutesToFull(snap, learnedWatts);
  return raw === null ? null : Math.ceil(raw);
}

export function officeWindow(
  snap: Snapshot,
  cfg: Config,
  now: Date,
  learnedWatts: number | null = null,
): OfficeWindow {
  const oh = cfg.officeHours;
  const etaMin = estimateMinutesToFull(snap, learnedWatts);
  const endMin = parseClock(oh.end);
  const applies = oh.enabled && oh.days.includes(now.getDay() as 0) && endMin !== null;
  if (!applies || endMin === null) {
    return { topupStart: null, end: null, graceEnd: null, etaMin, tooSlow: false };
  }
  return {
    topupStart: atMinutes(now, endMin - oh.leadMin).toISOString(),
    end: atMinutes(now, endMin).toISOString(),
    graceEnd: atMinutes(now, endMin + oh.graceMin).toISOString(),
    etaMin,
    tooSlow: etaMin !== null && etaMin > oh.leadMin,
  };
}

// ---------------------------------------------------------------------------
// Trip window
// ---------------------------------------------------------------------------

/** Times for one trip. Returns null if the start time is not valid. */
function windowFor(
  snap: Snapshot,
  cfg: Config,
  trip: Trip,
  now: Date,
  learnedWatts: number | null = null,
): TripWindow | null {
  const startMs = Date.parse(trip.start);
  if (Number.isNaN(startMs)) return null;
  const cal = cfg.calendar;
  const travelEstimated = trip.travelMin === null;
  const travelMin = trip.travelMin ?? cal.fallbackTravelMin;
  const leaveMs = startMs - (travelMin + cal.arriveBufferMin) * 60000;
  const etaMin = estimateMinutesToFull(snap, learnedWatts);
  // The 1.2 margin covers the slow charge above 80%. It applies to the unrounded time, so the ETA is not rounded twice.
  // The small offset removes float noise, for example 72.00000000000001.
  const rawMin = rawMinutesToFull(snap, learnedWatts) ?? cfg.officeHours.leadMin;
  const chargeMin = Math.ceil((rawMin * 12) / 10 - 1e-9);
  const topupMs = leaveMs - chargeMin * 60000;
  const nowMs = now.getTime();
  const tooLate = nowMs > topupMs && etaMin !== null && etaMin > 0 && nowMs + chargeMin * 60000 > leaveMs;
  return {
    id: trip.id,
    title: trip.title,
    location: trip.location,
    start: new Date(startMs).toISOString(),
    leaveAt: new Date(leaveMs).toISOString(),
    topupStart: new Date(topupMs).toISOString(),
    travelMin,
    travelEstimated,
    chargeMin,
    tooLate,
  };
}

/** Times for one trip. The CLI uses it to show every trip, not only the next one. */
export { windowFor as tripTimes };

/** The next trip with a leave time that is not past the grace time. null if calendar trips are off or no trip fits. */
export function tripWindow(
  snap: Snapshot,
  cfg: Config,
  trips: Trip[],
  now: Date,
  learnedWatts: number | null = null,
): TripWindow | null {
  if (!cfg.calendar.enabled) return null;
  const nowMs = now.getTime();
  const graceMs = cfg.calendar.graceMin * 60000;
  let best: TripWindow | null = null;
  for (const trip of trips) {
    // A known travel time below the minimum means the place is near. Do not top up for it.
    if (trip.travelMin !== null && trip.travelMin < cfg.calendar.minTravelMin) continue;
    const w = windowFor(snap, cfg, trip, now, learnedWatts);
    if (w === null) continue;
    if (!(nowMs < Date.parse(w.leaveAt) + graceMs)) continue;
    if (best === null || Date.parse(w.leaveAt) < Date.parse(best.leaveAt)) best = w;
  }
  return best;
}

// ---------------------------------------------------------------------------
// decide
// ---------------------------------------------------------------------------

interface Pending {
  event: NotifyEvent;
  body: () => string;
}

export const decide: DecideFn = (snap, cfg, stateIn, now, ctx) => {
  const st: RuntimeState = {
    ...stateIn,
    firedRules: [...stateIn.firedRules],
    override: stateIn.override ? { ...stateIn.override } : null,
  };
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const today = localDate(now);
  const dow = now.getDay();
  const pending: Pending[] = [];

  // 1. Place and base target.
  const place = resolvePlace(snap.routerMac, cfg);
  const base = baseTarget(place, cfg);
  let target = base;

  // 2. Drop fired rules from other days.
  st.firedRules = st.firedRules.filter((r) => r.endsWith("@" + today));

  // 3. Plug events.
  let plugEvent = false;
  if (st.lastAc === false && snap.ac) {
    plugEvent = true;
    st.lastPlugAt = nowIso;
    pending.push({ event: "plug", body: () => plugBody() });
  } else if (st.lastAc === true && !snap.ac) {
    st.lastUnplugAt = nowIso;
    pending.push({
      event: "unplug",
      body: () => {
        let t = `On battery at ${snap.percent}%.`;
        if (snap.minutesToEmpty !== null && snap.minutesToEmpty >= 0) {
          t += ` About ${formatDuration(snap.minutesToEmpty)} left.`;
        }
        return t;
      },
    });
    if (st.override && st.override.kind === "topup") st.override = null;
  }
  st.lastAc = snap.ac;
  st.lastPlace = place;

  // Learn the charge power. The ETA needs it while the battery holds and the live power is 0.
  if (snap.ac && snap.charging && snap.batteryWatts !== null && snap.batteryWatts >= 1) {
    const w = snap.batteryWatts;
    st.lastChargeWatts = st.lastChargeWatts === null ? w : st.lastChargeWatts * 0.7 + w * 0.3;
  }
  const learned = st.lastChargeWatts;

  // 4. Office hours.
  const win = officeWindow(snap, cfg, now, learned);
  const endClock = win.end ? clockOf(new Date(win.end)) : cfg.officeHours.end;
  let officeTopup = false;
  if (place === "office" && win.topupStart && win.graceEnd) {
    officeTopup = nowMs >= Date.parse(win.topupStart) && nowMs < Date.parse(win.graceEnd);
  }
  if (officeTopup) {
    target = 100;
    if (snap.ac && st.officeTopupNotified !== today) {
      st.officeTopupNotified = today;
      // The plug text already tells about the top-up. Do not send two texts for one event.
      if (!plugEvent) {
        pending.push({
          event: "officeTopupStart",
          body: () => `Office top-up started. Charges to 100% for ${endClock}.`,
        });
      }
    }
  }

  // 4b. Calendar trips.
  const trips = ctx?.trips ?? [];
  const tripWin = tripWindow(snap, cfg, trips, now, learned);
  if (st.tripTopup) {
    const latchId = st.tripTopup.id;
    if (!cfg.calendar.enabled || nowMs >= Date.parse(st.tripTopup.until) || !trips.some((t) => t.id === latchId)) {
      st.tripTopup = null;
    }
  }
  if (tripWin) {
    const untilMs = Date.parse(tripWin.leaveAt) + cfg.calendar.graceMin * 60000;
    if (nowMs >= Date.parse(tripWin.topupStart) && nowMs < untilMs) {
      st.tripTopup = { id: tripWin.id, until: new Date(untilMs).toISOString() };
    }
  }
  let tripActive = false;
  let tripLeaveClock = "";
  let tripTitle = "";
  if (st.tripTopup) {
    const latchId = st.tripTopup.id;
    const latchTrip = trips.find((t) => t.id === latchId);
    const w = tripWin && tripWin.id === latchId ? tripWin : latchTrip ? windowFor(snap, cfg, latchTrip, now, learned) : null;
    if (w) {
      tripActive = true;
      tripLeaveClock = clockOf(new Date(w.leaveAt));
      tripTitle = w.title;
      target = 100;
      if (snap.ac && st.tripTopupNotified !== w.id) {
        st.tripTopupNotified = w.id;
        // The plug text already tells about the top-up. Do not send two texts for one event.
        if (!plugEvent) {
          pending.push({
            event: "tripTopupStart",
            body: () => `Trip top-up started. Charges to 100% before you leave at ${tripLeaveClock} for ${tripTitle}.`,
          });
        }
      }
    }
  }

  function plugBody(): string {
    if (tripActive) {
      const tail = `Charges to 100% before you leave at ${tripLeaveClock} for ${tripTitle}.`;
      if (place === "away" || place === "offline") return `Plugged in. ${tail}`;
      return `Plugged in at ${cfg.places[place].label}. ${tail}`;
    }
    if (place === "away" && cfg.placeMode === "away") {
      return `Plugged in. Place is away, set by hand. Charges to ${base}%.`;
    }
    if (place === "away" || place === "offline") {
      return `Plugged in away from ${cfg.places.home.label} and ${cfg.places.office.label}. Charges to ${base}%.`;
    }
    const label = cfg.places[place].label;
    if (officeTopup) return `Plugged in at ${label}. Charges to 100% before ${endClock}.`;
    if (place === "office" && win.topupStart && nowMs < Date.parse(win.topupStart)) {
      return `Plugged in at ${label}. Holds ${base}% until ${clockOf(new Date(win.topupStart))}, then charges to 100% for ${endClock}.`;
    }
    return `Plugged in at ${label}. Charging stops at ${base}%.`;
  }

  // 5. Schedule.
  for (const rule of cfg.schedule) {
    if (!rule.enabled || !rule.days.includes(dow as 0)) continue;
    const t = parseClock(rule.time);
    if (t === null) continue;
    const key = `${rule.id}@${today}`;
    if (st.firedRules.includes(key)) continue;
    const startMs = atMinutes(now, t).getTime();
    if (!(startMs <= nowMs && nowMs < startMs + SCHEDULE_WINDOW_MIN * 60000)) continue;
    if (st.override && st.override.source === "user") continue;
    st.firedRules.push(key);
    const a = rule.action;
    let ov: Override;
    if (a.kind === "topup") {
      ov = { kind: "topup", target: 100, step: null, startedAt: nowIso, stepStartedAt: null, source: "schedule" };
    } else if (a.kind === "limit") {
      ov = { kind: "topup", target: a.value, step: null, startedAt: nowIso, stepStartedAt: null, source: "schedule" };
    } else if (a.kind === "discharge") {
      ov = { kind: "discharge", target: a.value, step: null, startedAt: nowIso, stepStartedAt: null, source: "schedule" };
    } else {
      ov = { kind: "calibrate", target: null, step: "drain", startedAt: nowIso, stepStartedAt: nowIso, source: "schedule" };
    }
    st.override = ov;
    break;
  }

  // 6. Overrides.
  let mode: Mode | null = null;
  let reason: string | null = null;
  let summary: string | null = null;
  let adapter = true;
  let nativeLimit: number | null = null;
  let skipHeat = false;

  const ov = st.override;
  if (ov) {
    if (ov.kind === "pause") {
      target = 100;
      nativeLimit = 100;
      adapter = true;
      mode = "paused";
      reason = "paused";
      summary = "ChargeGuard is paused. macOS charges normally.";
      skipHeat = true;
    } else if (ov.kind === "topup") {
      const t = ov.target ?? 100;
      target = t;
      if (snap.ac) {
        mode = "topup";
        reason = "override-topup";
        summary = snap.percent >= t ? `Top-up is complete at ${t}%.` : `Top-up is active. Charging to ${t}%.`;
      } else {
        mode = "unplugged";
        reason = "override-topup";
        summary = "On battery.";
      }
    } else if (ov.kind === "discharge") {
      const n = ov.target ?? base;
      target = n;
      if (!snap.ac) {
        mode = "unplugged";
        reason = "discharge";
        summary = "On battery.";
        skipHeat = true;
      } else if (snap.percent > n) {
        nativeLimit = n;
        mode = "discharging";
        skipHeat = true;
        if (snap.clamshell && !cfg.dischargeInClamshell) {
          adapter = true;
          reason = "discharge-clamshell-paused";
          summary = `Discharge to ${n}% waits until the lid opens.`;
        } else {
          adapter = false;
          reason = "discharge";
          summary = `Discharging to ${n}%.`;
        }
      } else {
        st.override = null;
        target = base;
        pending.push({ event: "dischargeDone", body: () => `Discharge is complete at ${snap.percent}%.` });
      }
    } else if (ov.kind === "calibrate") {
      if (!snap.ac) {
        mode = "unplugged";
        reason = "calibration-unplugged";
        summary = "Connect the charger to continue calibration.";
        skipHeat = true;
      } else {
        let step = ov.step ?? "drain";
        const stepNote = (text: string): void => {
          pending.push({ event: "calibrationStep", body: () => text });
        };
        if (step === "drain" && snap.percent <= CALIBRATION_DRAIN_PCT) {
          step = "fill";
          ov.step = step;
          ov.stepStartedAt = nowIso;
          stepNote("Calibration step 2 of 4. Charging to 100%.");
        }
        if (step === "fill" && snap.percent >= 100) {
          step = "hold";
          ov.step = step;
          ov.stepStartedAt = nowIso;
          stepNote(`Calibration step 3 of 4. Holding at 100% for ${CALIBRATION_HOLD_MIN} min.`);
        }
        if (step === "hold") {
          if (ov.stepStartedAt === null) ov.stepStartedAt = nowIso;
          const elapsedMin = (nowMs - Date.parse(ov.stepStartedAt)) / 60000;
          if (elapsedMin >= CALIBRATION_HOLD_MIN) {
            step = "settle";
            ov.step = step;
            ov.stepStartedAt = nowIso;
            stepNote(`Calibration step 4 of 4. Discharging to ${base}%.`);
          }
        }
        if (step === "settle" && snap.percent <= base) {
          st.override = null;
          reason = "calibration-done";
          pending.push({ event: "calibrationStep", body: () => "Calibration is complete." });
        } else {
          mode = "calibrating";
          reason = `calibration-${step}`;
          if (step === "drain") {
            target = CALIBRATION_DRAIN_PCT;
            adapter = false;
            skipHeat = true;
            summary = `Calibration. Discharging to ${CALIBRATION_DRAIN_PCT}%.`;
          } else if (step === "fill") {
            target = 100;
            nativeLimit = 100;
            summary = "Calibration. Charging to 100%.";
          } else if (step === "hold") {
            target = 100;
            nativeLimit = 100;
            const left = Math.max(
              0,
              Math.ceil(CALIBRATION_HOLD_MIN - (nowMs - Date.parse(ov.stepStartedAt ?? nowIso)) / 60000),
            );
            summary = `Calibration. Holding at 100% for ${left} more min.`;
          } else {
            target = base;
            nativeLimit = base;
            adapter = false;
            skipHeat = true;
            summary = `Calibration. Discharging to ${base}%.`;
          }
        }
      }
    }
  }

  // 7. Heat.
  if (cfg.heat.enabled) {
    if (snap.tempC !== null) {
      if (!st.heatBlocked && snap.tempC >= cfg.heat.maxC) {
        st.heatBlocked = true;
        const temp = snap.tempC;
        pending.push({
          event: "heatPause",
          body: () =>
            `Battery is hot (${Math.round(temp)} °C). Charging stops until it cools to ${cfg.heat.resumeC} °C.`,
        });
      } else if (st.heatBlocked && snap.tempC <= cfg.heat.resumeC) {
        st.heatBlocked = false;
      }
    }
  } else {
    st.heatBlocked = false;
  }
  if (st.heatBlocked && snap.ac && !skipHeat) {
    nativeLimit = Math.max(MIN_NATIVE_LIMIT, Math.min(target, snap.percent));
    mode = "heat";
    reason = "heat";
    summary = `Battery is hot. Charging stops until it cools to ${cfg.heat.resumeC} °C.`;
  }

  // 8. Default native limit.
  let limit = nativeLimit ?? target;
  limit = Math.min(100, Math.max(MIN_NATIVE_LIMIT, Math.round(limit)));

  // 9. R9 safety. Never turn the adapter off below 10%.
  if (snap.percent < 10) adapter = true;

  // 10. Mode.
  let finalMode: Mode;
  if (mode !== null) {
    finalMode = mode;
  } else if (!snap.ac) {
    finalMode = "unplugged";
  } else if (snap.percent >= target) {
    finalMode = "holding";
  } else if (snap.charging) {
    finalMode = (officeTopup || tripActive) && target === 100 ? "topup" : "charging";
  } else {
    finalMode = "sailing";
  }
  st.sailing = finalMode === "holding" || finalMode === "sailing";

  // 15. Summary and reason defaults.
  if (summary === null) {
    if (finalMode === "unplugged") {
      summary = "On battery.";
    } else if (finalMode === "holding" && snap.percent > target + 1) {
      summary = `Above ${target}%. macOS uses the battery down to ${target}%, then holds.`;
    } else if (finalMode === "holding") {
      summary = `Holding at ${target}%. macOS stops charging here.`;
    } else if (tripActive) {
      summary = `Charging to 100% before you leave at ${tripLeaveClock} for ${tripTitle}.`;
    } else if (officeTopup) {
      summary = `Charging to 100% before ${endClock}.`;
    } else if (place === "offline") {
      summary = `No network. Charges to ${target}%.`;
    } else if (place === "away" && cfg.placeMode === "away") {
      summary = `Away, set by hand. Charges to ${target}%.`;
    } else if (place === "away") {
      summary = `Away from ${cfg.places.home.label} and ${cfg.places.office.label}. Charges to ${target}%.`;
    } else if (finalMode === "sailing") {
      summary = `Not charging. macOS starts again below ${target}%.`;
    } else {
      summary = `Charging to ${target}%.`;
    }
  }
  if (reason === null) {
    if (finalMode === "unplugged") reason = "unplugged";
    else if (tripActive) reason = "trip-topup";
    else if (officeTopup) reason = "office-topup";
    else if (place === "offline") reason = "offline";
    else if (place === "away") reason = "away";
    else if (finalMode === "sailing") reason = "sail";
    else reason = "limit";
  }

  // 11. LED.
  let led: Led;
  if (!cfg.magsafeLed || finalMode === "paused" || finalMode === "heat") {
    led = "system";
  } else if (!adapter) {
    led = "off";
  } else if (finalMode === "charging" || finalMode === "topup") {
    led = "orange";
  } else if (finalMode === "holding" || finalMode === "sailing") {
    led = "green";
  } else if (finalMode === "unplugged") {
    led = "system";
  } else {
    led = snap.charging ? "orange" : "green";
  }

  // 12. Low Power Mode.
  let lowPower: boolean | null = null;
  if (cfg.lowPower.enabled) {
    if (snap.ac) lowPower = false;
    else if (snap.percent <= cfg.lowPower.belowPct) lowPower = true;
  }

  // 13. Sleep prevention.
  const k = st.override?.kind;
  const preventSleep = cfg.sleepControl && (k === "topup" || k === "discharge" || k === "calibrate");

  // 14. Notifications.
  const notify: NotifyMessage[] = [];
  for (const p of pending) {
    if (cfg.notifications[p.event] === false) continue;
    notify.push({ event: p.event, title: "ChargeGuard", body: p.body() });
  }

  return {
    decision: {
      nativeLimit: limit,
      adapter,
      led,
      lowPower,
      preventSleep,
      target,
      place,
      mode: finalMode,
      reason,
      summary,
      notify,
    },
    state: st,
  };
};

// ---------------------------------------------------------------------------
// nextChange
// ---------------------------------------------------------------------------

function describeAction(a: Config["schedule"][number]["action"]): string {
  switch (a.kind) {
    case "topup":
      return "top-up";
    case "calibrate":
      return "calibration";
    case "limit":
      return `limit ${a.value}%`;
    case "discharge":
      return `discharge to ${a.value}%`;
  }
}

export function nextChange(
  snap: Snapshot,
  cfg: Config,
  state: RuntimeState,
  now: Date,
  trips: Trip[] = [],
): string | null {
  const place = resolvePlace(snap.routerMac, cfg);
  const win = officeWindow(snap, cfg, now, state.lastChargeWatts);
  const nowMs = now.getTime();
  const officeApplies = place === "office" && !!win.topupStart && !!win.graceEnd && !!win.end;

  // A trip comes first if its leave time is before the office end, or if there is no office window.
  const tw = tripWindow(snap, cfg, trips, now, state.lastChargeWatts);
  if (tw && nowMs < Date.parse(tw.leaveAt) && (!officeApplies || Date.parse(tw.leaveAt) < Date.parse(win.end!))) {
    const leaveClock = clockOf(new Date(tw.leaveAt));
    if (nowMs < Date.parse(tw.topupStart)) {
      const drive = `${tw.travelEstimated ? "about " : ""}${Math.round(tw.travelMin)} min drive`;
      return `Meeting ${tw.title} at ${clockOf(new Date(tw.start))}. Leave ${leaveClock}, ${drive}. Top-up starts ${clockOf(new Date(tw.topupStart))}.`;
    }
    const eta = win.etaMin ?? cfg.officeHours.leadMin;
    return `Full by about ${clockOf(new Date(nowMs + eta * 60000))}. Leave ${leaveClock} for ${tw.title}.`;
  }

  if (place === "office" && win.topupStart && win.graceEnd && win.end) {
    const start = Date.parse(win.topupStart);
    const endClock = clockOf(new Date(win.end));
    if (nowMs < start) {
      const startClock = clockOf(new Date(start));
      return win.tooSlow
        ? `Top-up starts ${startClock}. This charger is slow; it can miss ${endClock}.`
        : `Top-up starts ${startClock}. Full by about ${endClock}.`;
    }
    if (nowMs < Date.parse(win.graceEnd) && win.etaMin !== null && win.etaMin > 0) {
      return `Full by about ${clockOf(new Date(nowMs + win.etaMin * 60000))}.`;
    }
  }

  const today = localDate(now);
  const dow = now.getDay();
  let best: { ms: number; text: string } | null = null;
  for (const rule of cfg.schedule) {
    if (!rule.enabled || !rule.days.includes(dow as 0)) continue;
    const t = parseClock(rule.time);
    if (t === null) continue;
    if (state.firedRules.includes(`${rule.id}@${today}`)) continue;
    const ms = atMinutes(now, t).getTime();
    if (ms <= nowMs) continue;
    if (best === null || ms < best.ms) {
      best = { ms, text: `Schedule: ${describeAction(rule.action)} at ${formatClock(t)}.` };
    }
  }
  return best ? best.text : null;
}
