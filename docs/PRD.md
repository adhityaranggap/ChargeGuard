# ChargeGuard PRD

Status: approved 2026-11-11. Design details are in DESIGN.md.


## Context

The user has a new MacBook Pro M5 (`Mac17,3`, macOS 27.2.1, 2 cycles, 100% health).
The user wants the Mac to stop at 80% when it is at Home or at the Office. At other places it charges to 100%.
The Mac must check the place each time the charger is connected, and also during long stays.
At the Office, the Mac must charge to 100% before the user goes home.
The user also wants a full feature set like a paid charge-manager app, plus a good wallpaper widget.

Decisions from the user so far:

- Current Wi-Fi (router 192.168.100.1, MAC `9c:71:3a:40:db:9f`) is **Home**.
- Default limit is **80%**.
- Charge control uses the native macOS 27 charge limit. Discharge and LED use the `smc` binary from the open source `battery` project. See "Charge control backend".
- Runtime is **Bun + TypeScript**, not Python.
- Plan and review by Opus. Workers and the collector run on Sonnet.

### Why Bun, not Python

Python was only the first choice because it was already installed. Bun is better here:

- One language (TypeScript) for the daemon, the CLI, and the Übersicht widget (JSX). Shared types for `config.json` and `status.json`.
- Bun runs `.ts` files directly. There is no compile step, so the no-local-build rule is not a problem.
- `bun test` is built in. Fast start (about 10 ms) for CLI calls from the widget and menu bar.
- Bun 1.2.18 is already at `~/.bun/bin/bun`.

Cost: the daemon uses about 30 to 40 MB RAM. That is acceptable.

### Facts found on this Mac

- `pmset -g batt` and `ioreg -r -c AppleSmartBattery` give percent, AC, charging, adapter watts, health.
- The charger now connected is a 5 V, 7 W USB-PD charger. A charge from 80% to 100% will be slow with it. The widget will show this.
- Battery temperature is **not** in `ioreg` on this M5. Read it from SMC keys (`TB0T`, `TB1T`, `TB2T`) in milestone M0.
- macOS redacts the Wi-Fi SSID without Location permission. Place detection uses the **router MAC** of the default gateway (`route -n get default` + `arp -n`). This needs no permission.
- `sudo` needs a password. SMC writes and `pmset lowpowermode` need a one-time sudoers rule.
- Runner `root@103.105.79.121` works over SSH. It has no Bun yet. Tests run there.
- A `brew install --cask battery ubersicht` is still in progress in the background (slow Übersicht download).

## 1. Product requirements (PRD)

Priority: P0 = must have in v1, P1 = v1 if time, P2 = later.

| ID | Feature | Behavior | Pri |
|---|---|---|---|
| R1 | Charge limit | Stop charging at the target (50 to 100, default 80). Keep the Mac on AC power. | P0 |
| R2 | Places | Save Home and Office from the widget or CLI by the current router MAC. A place can have more than one router MAC. Unknown network = Away = 100%. | P0 |
| R3 | Place check | Check the place at each plug-in and every 30 s. A long stay at a place stays correct. | P0 |
| R4 | Office hours | Days, start, end, and lead time (default Mon to Fri, 08:00 to 17:00, lead 90 min). From `end - lead` to `end + 120 min`, target = 100%. After that, back to the limit. | P0 |
| R5 | Plug-in reminder | On plug-in: a macOS notification and an animated banner on the widget. Text: place, target, and when it stops. | P0 |
| R6 | Sailing mode | After the target, do not charge again until percent ≤ target − sail (default 5). | P0 |
| R7 | Top up | One-shot charge to 100%. It stops when the charger is disconnected. | P0 |
| R8 | Heat protection | Stop charging at battery temp ≥ 35 °C. Resume at ≤ 32 °C. | P0 |
| R9 | Fail-safe | If the daemon stops, a sensor fails 3 times, or the user uninstalls, set charging on, adapter on, LED system. Never disable the adapter below 10%. | P0 |
| R10 | Discharge | Manual: use the battery while on AC until percent ≤ X. Disable the adapter through SMC. | P1 |
| R11 | Automatic discharge | If on AC and percent > target + sail, discharge to target. Default off. | P1 |
| R12 | Discharge in clamshell | If the lid is closed, pause discharge (adapter on, charging off) unless this option is on. Default off. | P1 |
| R13 | MagSafe LED | Green = holding at target. Orange = charging. Off = discharging. System = not managed. | P1 |
| R14 | Calibration | Discharge to 15%, charge to 100%, hold 60 min, discharge to target. Needs AC. Can be stopped. | P1 |
| R15 | Schedule | Rules: days + time → action (`topup`, `calibrate`, `limit N`, `discharge N`). Office hours is a built-in rule. | P1 |
| R16 | Sleep control | While top-up, discharge, or calibration runs, hold `caffeinate -i` so the task can finish. | P1 |
| R17 | Stop charging when sleeping | On sleep, disable charging. On wake, evaluate again. Uses `sleepwatcher` hooks. Default on. | P1 |
| R18 | Low Power Mode control | On battery and below X% (default 20), turn Low Power Mode on. On AC, turn it off. Default off. | P1 |
| R19 | Shortcuts support | Every action is a `cg` CLI command with `--json` output. Docs give "Run Shell Script" recipes. | P1 |
| R20 | Menu bar | SwiftBar plugin. Icon style (`battery`, `percent`, `bolt`, `leaf`) and dropdown sections are set in config. | P1 |
| R21 | Wallpaper widget | Übersicht widget. Status, controls, and settings. See section 3. | P0 |
| R22 | Battery history | Sparkline of the last 24 h. | P2 |
| R23 | Calendar trips | Read timed calendar events with a physical place for the next 24 h. Charge to 100% before the user leaves. Default off. See the criteria below. | P1 |

Non-goals for v1: Intel Macs, a native Swift app, App Store release, license or paid tiers, any copy of another app's name, icons, or look.

### R23 Calendar trips: acceptance criteria

- C1: The widget host runs `scripts/cg-calendar.js` every 10 min when `calendar.enabled` is true. It writes `~/.chargeguard/trips.json` as `[{id, title, start, location, travelMin, from, computedAt}]`.
- C2: The script skips all-day events, events without a place, online meetings, and places that Apple Maps cannot find.
- C3: Apple Maps gives the drive time from the saved Home or Office address. The script uses the current place from `status.json`.
- C4: Leave time = start − drive time − `arriveBufferMin` (default 10).
- C5: Top-up start = leave time − time to full × 1.2. The target is 100% from the top-up start until leave time + `graceMin` (default 30).
- C6: If the drive time is less than `minTravelMin` (default 10), the trip makes no top-up.
- C7: If the drive time is unknown (Away place or no address), the daemon uses `fallbackTravelMin` (default 45).
- C8: A trip top-up stays on after it starts, also when the Mac charges and the estimate goes down. It stops when the event ends or leaves `trips.json`.
- C9: A user override (pause, discharge) wins over a trip top-up. The daemon ignores `trips.json` if it is older than 30 min.
- C10: `cg trips [--json]` shows the next trips and times. `cg calendar on|off|refresh`, `cg set places.<home|office>.address "..."`, and `cg set calendar.<key> N` work. The widget has Settings > Calendar with **Grant calendar access**.
- C11: Privacy. The feature uses no GPS and no Location Services. Only Apple Maps gets addresses and event places. Nothing else leaves the Mac.
- C12: If Calendar access is denied, the feature does nothing and the widget shows how to allow access. The default charge rules stay in force.

### Acceptance checks (P0)

- A1: At Home on AC, the Mac charges to 80% and holds. `cg status` shows `place=home target=80 mode=holding`.
- A2: On an unknown network, the target is 100%.
- A3: On a weekday at Office, at 15:30 with end 17:00, the target changes to 100%.
- A4: Plug-in at Home shows a notification within 5 s and the widget banner for 20 s.
- A5: `cg place save office` at the office adds the router MAC. The widget shows "Office ✓".
- A6: Battery temp ≥ 35 °C stops charging. Status shows `reason=heat`.
- A7: `launchctl bootout` of the daemon leaves charging on (SMC read shows enabled).
- A8: All policy tests pass with `bun test` on the runner.

## 2. Architecture

Source: `~/NE/chargeguard/`. Install target: `~/.chargeguard/` (config, state, status, logs, app copy).

```
~/NE/chargeguard/
  package.json            no runtime deps; devDeps: @types/bun, typescript
  tsconfig.json
  src/types.ts            CONTRACT: Config, Snapshot, Decision, RuntimeState, Status (Opus writes first)
  src/policy.ts           pure decide(snapshot, config, state, now) -> { decision, state }
  src/config.ts           defaults, validate, atomic save (tmp + rename)
  src/smc.ts              smc read/write, key probe, fail-safe restore
  src/sensors.ts          ioreg/pmset parse, SMC temp, clamshell, adapter watts
  src/net.ts              gateway IP + router MAC (normalized aa:bb:cc:dd:ee:ff)
  src/daemon.ts           30 s loop + fs.watch on ~/.chargeguard/kick, apply diffs only, status.json, notify, caffeinate
  src/cli.ts              all commands, --json
  src/menubar.ts          SwiftBar text output
  bin/cg                  #!/Users/rangga-sa/.bun/bin/bun shim -> src/cli.ts
  widget/chargeguard.widget/index.jsx   Übersicht widget
  swiftbar/chargeguard.10s.sh           calls `cg menubar`
  launchd/com.chargeguard.daemon.plist  user agent, RunAtLoad, KeepAlive
  hooks/sleep, hooks/wake               sleepwatcher scripts -> `cg hook sleep|wake`
  scripts/install.sh                    user part: copy, launchd, widget, SwiftBar plugin
  scripts/install-root.sh               sudo part: /etc/sudoers.d/chargeguard allowlist
  scripts/uninstall.sh                  fail-safe restore, then remove
  scripts/cg-calendar.js                JXA probe: calendar events + Apple Maps drive time -> ~/.chargeguard/trips.json
  tests/policy.test.ts, tests/config.test.ts, tests/menubar.test.ts, tests/fixtures/*
  docs/PRD.md, docs/DESIGN.md, docs/VERIFICATION.md, README.md
```

### Data flow

1. The daemon reads a `Snapshot`: percent, AC, charging, temp, clamshell, router MAC, adapter watts, health.
2. `policy.decide()` returns a `Decision`: charge on/off, adapter on/off, LED, low power, prevent sleep, target, place, mode, reason, events.
3. The daemon writes to SMC only when the decision changes. It writes `~/.chargeguard/status.json` each tick.
4. The CLI, widget, and menu bar change `config.json` or `state.json` only through `cg`. `cg` touches `~/.chargeguard/kick`, and the daemon runs a tick within 1 s.

### Contracts (summary; full types in `src/types.ts`)

- `Config`: `limit`, `sail`, `awayLimit`, `places.home|office {label, routers[], limit?}`, `officeHours {enabled, days[], start, end, leadMin, graceMin}`, `heat {enabled, maxC, resumeC}`, `autoDischarge`, `dischargeInClamshell`, `stopChargingWhenSleeping`, `sleepControl`, `lowPower {enabled, belowPct}`, `magsafeLed`, `schedule[]`, `notifications`, `menubar {icon, sections[]}`, `calendar {enabled, arriveBufferMin, fallbackTravelMin, minTravelMin, graceMin, lookaheadH}`. A place also has `address`.
- `RuntimeState`: `override {kind: topup|discharge|calibrate|pause, target, step, startedAt}`, `sailing`, `heatBlocked`, `lastAc`, `lastPlace`, `lastPlugAt`, `sensorFailures`, `tripTopup {id, until}`.
- `Status` (for UI): snapshot + decision + `next` (for example "Top-up starts 15:30, full by about 17:00") + `trip` (next calendar trip with `leaveAt`, `topupStart`, `travelMin`, `chargeMin`, or null) + `health {daemon, smc, sudo}` + `updatedAt`.
- Modes: `holding`, `charging`, `sailing`, `topup`, `discharging`, `calibrating`, `heat`, `paused`, `unplugged`, `error`.

### Charge control backend (M0 probe result, 2026-11-11)

On this M5 with macOS 27, Apple gates the SMC charge keys `CHTE`, `CH0B`, `CH0C` behind a private entitlement. They return "no data". ChargeGuard uses these controls:

| Purpose | Mechanism | Probe result |
|---|---|---|
| Charge limit 10..99 | As root: `defaults write com.apple.smartcharging.topoffprotection MCLFeatureState -int 1`, `defaults write ... mclLimitValue -int N`, then `notifyutil -p com.apple.smartcharging.defaultschanged`. `PowerUIAgent` (root, pid 464) applies it. | Works. `pmset -g battlimit` shows `chargeSocLimitSoc = 80`, `chargeSocLimitDrain = 1`. |
| No limit (100) | As root: `MCLFeatureState -int 1` + `mclLimitValue -int 100` + notify. Verify with `pmset -g battlimit`. | `MCLFeatureState 0` did not lift the limit in the live test on 2026-11-13. The new method needs a live test. |
| Read current limit | `pmset -g battlimit` (no root). Parse `chargeSocLimitSoc`. | Works. |
| Adapter off / on (discharge) | `smc -k CHIE -w 08` / `-w 00` | Works. The Mac runs on battery while plugged. |
| MagSafe LED | `smc -k ACLC -w 00/01/03/04` (system/off/green/orange) | Works. |
| Battery temperature | `smc -k TB0T -r` (float °C, no root) | Works, 33 °C. |

Effects on requirements:

- R1: the native limit holds in firmware, also during sleep. macOS can take seconds to minutes to apply a change.
- R6 sailing: macOS controls the restart point. Config `sail` is kept for display only.
- R11 automatic discharge: `chargeSocLimitDrain = 1` means macOS drains to the limit by itself. ChargeGuard does not use `CHIE` for this.
- R17 stop charging when sleeping: covered by the native limit. The sleep hook only stops discharge and calibration before sleep.
- R8 heat: set the native limit to the current percent while hot. Restore after cool down.
- R10 discharge and R14 calibration: use `CHIE`.

Privileged work runs only through one root-owned helper: `/usr/local/libexec/chargeguard/cg-helper` (bash, root:wheel, 755). It accepts only these commands, with strict validation:

```
cg-helper limit <10..100>      # 100 = MCLFeatureState 1 + mclLimitValue 100
cg-helper adapter on|off
cg-helper led system|off|green|orange
cg-helper lowpower 0|1
```

`/etc/sudoers.d/chargeguard`: `rangga-sa ALL=(root) NOPASSWD: /usr/local/libexec/chargeguard/cg-helper`. The `smc` binary is installed root-owned at `/usr/local/libexec/chargeguard/smc` (SHA-256 `e3b4392c966dee700f3e1d6cc3812c0d487954c3d6d77b91f521a9590aadae44`, from `actuallymentor/battery` `dist/smc`). The `battery.app` charge loop is not used.

## 4. Milestones and agent assignments

No two agents write the same file at the same time. Workers use `model: sonnet`.

| M | Work | Owner | Writes | Done when |
|---|---|---|---|---|
| M0 | Write `docs/PRD.md` and `docs/DESIGN.md` from this plan. Write `src/types.ts` contract and test fixtures. Probe SMC keys and temp keys after the `battery` cask installs `smc`. | Opus (me) | `docs/`, `src/types.ts`, `tests/fixtures/` | Files exist; probe table filled in `docs/VERIFICATION.md` |
| M1 | `policy.ts` + `config.ts` + tests for R1 to R18 rules | Worker A (Sonnet, backend) | `src/policy.ts`, `src/config.ts`, `tests/policy.test.ts`, `tests/config.test.ts` | Tests written; runnable by collector |
| M2 | System layer: `smc.ts`, `sensors.ts`, `net.ts`, `daemon.ts`, `cli.ts`, `menubar.ts`, `bin/cg`, launchd, hooks, scripts, SwiftBar plugin | Worker B (Sonnet, devops) | those files, `tests/menubar.test.ts` | Code complete; uses only `types.ts` contract |
| M3 | Übersicht widget per DESIGN.md, from `tests/fixtures/status-*.json` | Worker C (Sonnet, frontend-developer) | `widget/` | All states render from fixtures |
| M4 | Collect: rsync to runner, install Bun there in `/mnt/hdd-work/bun`, run `bun test` and `bunx tsc --noEmit`, fix contract mismatches, write README and Shortcuts recipes | Collector (Sonnet) | fixes + `README.md`, `docs/VERIFICATION.md` | Tests and typecheck pass on runner, output recorded |
| M5 | Review diff (correctness, fail-safe, sudoers scope). Install with the user. | Opus (me) | small fixes | A1 to A7 checked on this Mac |

M1, M2, M3 run in parallel after M0.

## 5. Install steps on this Mac (M5)

1. Wait for the brew cask install to finish. Then `brew install --cask swiftbar` and `brew install sleepwatcher`.
2. The user runs once: `! sudo bash ~/NE/chargeguard/scripts/install-root.sh` (sudoers allowlist).
3. I run `scripts/install.sh` (no sudo): copy to `~/.chargeguard`, load launchd agent, link the widget into Übersicht, link the SwiftBar plugin, set sleepwatcher hooks.
4. `cg place save home` (now). At the office: click "Use current Wi-Fi" on the Office row.

The daemon runs locally because it is the product. Tests and type checks run only on the runner.

## 6. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| SMC keys differ on M5 / macOS 27 | No charge control | M0 probe before workers start; abort the plan if no key writes |
| Daemon crash with charging off | Battery drains or stays low | launchd KeepAlive; fail-safe restore in uninstall and on SIGTERM; never adapter-off below 10% |
| Sleep overshoot | Charges past limit during sleep | R17 sleep hook disables charging |
| Router MAC changes (new router, mesh) | Place = Away = 100% | Several MACs per place; widget shows "unknown router, save?" |
| 7 W charger | Office top-up does not reach 100% | Widget ETA warning, longer lead time |
| Übersicht desktop clicks | Buttons do not work | README: enable interaction in Übersicht preferences; SwiftBar gives the same actions |
| Sudoers too broad | Privilege risk | Exact-command allowlist, `visudo -cf` check |

## 7. Verification

- Runner: `ssh root@103.105.79.121 'cd /mnt/hdd-work/chargeguard && ~/.bun/bin/bun test && ~/.bun/bin/bunx tsc --noEmit'`. Record output in `docs/VERIFICATION.md`.
- Mac (read-only checks + product run): `cg doctor` (smc found, keys, sudo rule, daemon), `cg status --json`, `smc -k CHTE -r` before and after the limit, `launchctl print gui/$UID/com.chargeguard.daemon`.
- Manual A1 to A7: unplug and plug the charger at Home; set a fake office router with `cg place save office --router <mac>` to test office hours with a short window; `launchctl bootout` to check fail-safe.
- Widget: screenshots of every fixture state (Home holding, charging, Office top-up, Away first-time, heat, daemon stopped, setup needed) in light and dark.
