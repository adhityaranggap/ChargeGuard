import { describe, expect, test } from "bun:test";
import { parseBattLimit } from "../src/helper";
import { parseArp, parseDefaultRoute } from "../src/net";
import { parseAc, parseBatteryPower, parseBattery, parseClamshell, parsePmsetPercent } from "../src/sensors";
import { parseSmcFloat } from "../src/smc";

// Real text from docs/probe-m0.log (one-line ioreg output).
const IOREG_CHARGING =
  ' | "ExternalConnected" = Yes  | "CurrentCapacity" = 99  | "ChargerData" = {"NotChargingReason"=0,"SlowChargingReason"=0,"PMUConfigured"=1384,"PMUConfiguration"=1460,"TimeChargingThermallyLimited"=0,"IsCharging"=1}  | "BatteryData" = {"CurrentCapacity"=99,"AppleRawMaxCapacity"=4691,"AppleRawCurrentCapacity"=4400,"AbsoluteCapacity"=0,"AvgTimeToEmpty"=65535,"DesignCapacity"=4629,"NominalChargeCapacity"=4818,"FullChargeCapacity"=4691,"MaxCapacity"=100,"FullyCharged"=0,"RemainingCapacity"=4400,"BatteryPower"=209,"TrueRemainingCapacity"=0}  | "IsCharging" = Yes ';

const IOREG_BATTERY =
  ' | "ExternalConnected" = No  | "CurrentCapacity" = 99  | "ChargerData" = {"NotChargingReason"=4096,"SlowChargingReason"=0,"PMUConfigured"=0,"PMUConfiguration"=0,"TimeChargingThermallyLimited"=0,"IsCharging"=0}  | "BatteryData" = {"CurrentCapacity"=99,"AppleRawMaxCapacity"=4691,"AppleRawCurrentCapacity"=4399,"AbsoluteCapacity"=0,"AvgTimeToEmpty"=838,"DesignCapacity"=4629,"NominalChargeCapacity"=4818,"FullChargeCapacity"=4691,"MaxCapacity"=100,"FullyCharged"=0,"RemainingCapacity"=4399,"BatteryPower"=18446744073709544486,"TrueRemainingCapacity"=0}  | "IsCharging" = No ';

// Real multi-line ioreg output from `ioreg -r -c AppleSmartBattery`, shortened.
const IOREG_MULTI = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x1, registered, matched, active, busy 0 (0 ms), retain 6>
  {
    "ExternalConnected" = Yes
    "AvgTimeToEmpty" = 396
    "AdapterDetails" = {"IsWireless"=No,"AdapterID"=0,"AdapterVoltage"=5000,"FamilyCode"=18446744073172697098,"AdapterPowerTier"=1,"Watts"=7,"UsbHvcHvcIndex"=0,"Current"=1460,"PMUConfiguration"=0,"UsbHvcMenu"=({"Index"=0,"MaxCurrent"=1460,"MaxVoltage"=5000}),"Description"="pd charger"}
    "PowerTelemetryData" = {"SystemPowerIn"=86,"BatteryPower"=18446744073709526250,"BatteryDischargeAccumulatorCount"=4820}
    "CurrentCapacity" = 98
    "CycleCount" = 2
    "ChargerData" = {"NotChargingReason"=16777216,"SlowChargingReason"=0,"PMUConfigured"=0,"PMUConfiguration"=0,"TimeChargingThermallyLimited"=0,"IsCharging"=0}
    "BatteryData" = {"CurrentCapacity"=98,"AppleRawMaxCapacity"=4685,"AppleRawCurrentCapacity"=4365,"AbsoluteCapacity"=0,"AvgTimeToEmpty"=396,"DesignCapacity"=4629,"NominalChargeCapacity"=4812,"FullChargeCapacity"=4685,"MaxCapacity"=100,"FullyCharged"=0,"RemainingCapacity"=4365,"BatteryPower"=18446744073709544435,"TrueRemainingCapacity"=0}
    "AvgTimeToFull" = 65535
    "IsCharging" = No
  }`;

const CLAMSHELL = `    "AppleClamshellCausesSleep" = Yes
    "AppleClamshellState" = No`;

describe("parseBattery", () => {
  test("AC and charging, one-line text", () => {
    const b = parseBattery(IOREG_CHARGING);
    expect(b.percent).toBe(99);
    expect(b.ac).toBe(true);
    expect(b.charging).toBe(true);
    expect(b.healthPct).toBe(100); // 4691 / 4629 is above 100, so the cap applies
    expect(b.minutesToEmpty).toBeNull(); // 65535
    expect(b.batteryWatts).toBeCloseTo(0.209, 5);
  });

  test("on battery: negative BatteryPower, no adapter watts", () => {
    const b = parseBattery(IOREG_BATTERY);
    expect(b.ac).toBe(false);
    expect(b.charging).toBe(false);
    expect(b.adapterWatts).toBeNull();
    expect(b.minutesToEmpty).toBe(838);
    expect(b.batteryWatts).toBeCloseTo(-7.13, 5);
  });

  test("multi-line text", () => {
    const b = parseBattery(IOREG_MULTI);
    expect(b.percent).toBe(98);
    expect(b.ac).toBe(true);
    expect(b.charging).toBe(false);
    expect(b.adapterWatts).toBe(7);
    expect(b.cycleCount).toBe(2);
    expect(b.minutesToEmpty).toBe(396);
    expect(b.minutesToFull).toBeNull();
    expect(b.healthPct).toBe(100);
    // BatteryPower comes from BatteryData, not PowerTelemetryData.
    expect(b.batteryWatts).toBeCloseTo(-7.181, 3);
  });

  test("empty text gives safe values", () => {
    const b = parseBattery("");
    expect(b.percent).toBeNull();
    expect(b.ac).toBe(false);
    expect(b.healthPct).toBeNull();
  });
});

describe("small parsers", () => {
  test("parseBatteryPower with BigInt", () => {
    expect(parseBatteryPower("18446744073709544486")).toBeCloseTo(-7.13, 5);
    expect(parseBatteryPower("209")).toBeCloseTo(0.209, 5);
    expect(parseBatteryPower("abc")).toBeNull();
  });
  test("parseAc", () => {
    expect(parseAc(IOREG_CHARGING)).toBe(true);
    expect(parseAc(IOREG_BATTERY)).toBe(false);
    expect(parseAc("nothing")).toBeNull();
  });
  test("parseClamshell", () => {
    expect(parseClamshell(CLAMSHELL)).toBe(false);
    expect(parseClamshell('"AppleClamshellState" = Yes')).toBe(true);
    expect(parseClamshell("")).toBe(false);
  });
  test("parsePmsetPercent", () => {
    const t = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23003235)\t98%; AC attached; not charging present: true";
    expect(parsePmsetPercent(t)).toBe(98);
    expect(parsePmsetPercent("")).toBeNull();
  });
});

const TWO_ENTRIES = `Battery level limits:
(
        {
        Terminated = 0;
        chargeSocLimitDrain = 1;
        chargeSocLimitIsEOC = 1;
        chargeSocLimitNoChargeToFull = 0;
        chargeSocLimitOwner = 464;
        chargeSocLimitReason = manualChargeLimit;
        chargeSocLimitSoc = 80;
    },
        {
        Terminated = 0;
        chargeSocLimitDrain = 1;
        chargeSocLimitIsEOC = 1;
        chargeSocLimitNoChargeToFull = 0;
        chargeSocLimitOwner = 0;
        chargeSocLimitReason = manualChargeLimit;
        chargeSocLimitSoc = 80;
    }
)`;

describe("parseBattLimit", () => {
  test("no limit", () => {
    expect(parseBattLimit("No battery level limits set\n")).toBeNull();
  });
  test("two entries", () => {
    expect(parseBattLimit(TWO_ENTRIES)).toBe(80);
  });
  test("owner 0 entry comes first: use the entry with an owner", () => {
    const t = `Battery level limits:
(
        {
        chargeSocLimitOwner = 0;
        chargeSocLimitSoc = 90;
    },
        {
        chargeSocLimitOwner = 464;
        chargeSocLimitSoc = 70;
    }
)`;
    expect(parseBattLimit(t)).toBe(70);
  });
  test("only owner 0: first entry", () => {
    const t = TWO_ENTRIES.replace("chargeSocLimitOwner = 464", "chargeSocLimitOwner = 0");
    expect(parseBattLimit(t)).toBe(80);
  });
});

describe("parseSmcFloat", () => {
  test("float bytes", () => {
    // bytes 64 66 02 42 = 0x42026664 = 32.6
    expect(parseSmcFloat("  TB0T  [flt ]  33 (bytes 64 66 02 42)")).toBeCloseTo(32.6, 1);
  });
  test("integer fallback", () => {
    expect(parseSmcFloat("  TB1T  [ui8 ]  31 (bytes 1f)")).toBe(31);
  });
  test("no data", () => {
    expect(parseSmcFloat("  CHTE  [    ]  no data")).toBeNull();
  });
  test("out of range", () => {
    expect(parseSmcFloat("  TB0T  [ui8 ]  250 (bytes fa)")).toBeNull();
  });
});

describe("net", () => {
  test("parseDefaultRoute", () => {
    const t = `   route to: default
destination: default
       mask: default
    gateway: 192.168.100.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PROTO1,PRCLONING,IFSCOPE,GLOBAL>`;
    expect(parseDefaultRoute(t)).toEqual({ gateway: "192.168.100.1", iface: "en0" });
    expect(parseDefaultRoute("route: writing to routing socket: not in table")).toEqual({ gateway: null, iface: null });
  });
  test("parseArp", () => {
    expect(parseArp("? (192.168.100.1) at 9c:71:3a:40:db:9f on en0 ifscope [ethernet]")).toBe("9c:71:3a:40:db:9f");
    expect(parseArp("? (192.168.100.1) at (incomplete) on en0 ifscope [ethernet]")).toBeNull();
    expect(parseArp("192.168.100.9 (192.168.100.9) -- no entry")).toBeNull();
  });
});
