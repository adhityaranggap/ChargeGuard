# ChargeGuard native Mac app: plan

Status: draft, 2026-11-11. Not approved. No code exists for this plan yet.

## 1. Goal

Make ChargeGuard an app that other people can install and use without Terminal.
The user drags `ChargeGuard.app` to Applications, opens it, and answers a short setup.
All settings are in the app. The command line stays as an option for advanced users.

## 2. Scope

In scope:

- One app bundle that holds the menu bar icon, the desktop widget, the Settings window, and the setup screens.
- A privileged helper inside the bundle. macOS installs it after one approval in System Settings.
- A port of the current policy (`src/policy.ts`) to Swift, with the same behavior and the same tests.
- All P0 and P1 features from `docs/PRD.md`, with native replacements for SwiftBar, Übersicht, sleepwatcher, Bun, and the `smc` binary.
- Migration of `~/.chargeguard/config.json` for the current user.
- Signed, notarized DMG and automatic updates.

Out of scope for v1:

- Intel Macs.
- The Mac App Store. The App Store does not allow a root helper that writes SMC keys.
- Wi-Fi name (SSID) matching. This is P2. See section 8.
- Paid tiers, licenses, and accounts.

## 3. Decisions the user must make

These decisions block milestones. Section 9 shows which milestone needs each one.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Where to build | (a) GitHub Actions macOS runner. (b) A remote Mac over SSH. (c) Allow Xcode builds on this Mac for this project only. | (a). Your rule forbids local builds, and the Linux runner cannot build macOS apps. |
| D2 | Apple Developer account | (a) Pay $99 per year for Developer ID signing and notarization. (b) No account: ad-hoc signing only. | (a). With (b), every user sees Gatekeeper warnings. The helper install can also fail. M0 checks this. |
| D3 | Widget technology | (a) SwiftUI rewrite. (b) Keep the current JSX widget in a WKWebView. | (a). It removes React and Babel, it looks native, and it is smaller. (b) is faster to ship. |
| D4 | Lowest macOS version | The native charge limit sets the floor. | The first version with `pmset battlimit`. M0 finds it. |
| D5 | Name and icon | The current name is ChargeGuard. | Check that no other app uses this name before release. |

## 4. Assumptions

- A1: Only Apple Silicon Macs. The current code was tested on an M5 with macOS 27.2.1.
- A2: The native charge limit (`pmset battlimit`) does the main limit work. The helper writes SMC keys only for the adapter (discharge), the MagSafe LED, and the heat pause.
- A3: An app can register a root LaunchDaemon with `SMAppService.daemon`. The user approves it one time in System Settings > General > Login Items.
- A4: The SMC keys in `scripts/cg-helper` (`CHIE` for the adapter, the LED key) work the same when IOKit writes them from Swift.
- A5: The router MAC method in `src/net.ts` works from the app without extra permissions.

M0 tests A2, A3, and A4. If one fails, the plan changes before M1 starts.

## 5. Architecture

```
ChargeGuard.app
  Contents/MacOS/ChargeGuard            UI app. No Dock icon (LSUIElement).
  Contents/MacOS/cg                     optional CLI. Talks to the app over XPC.
  Contents/Library/LaunchDaemons/
    app.chargeguard.helper.plist        registered with SMAppService.daemon
  Contents/Library/LaunchServices/... or Contents/Helpers/
    ChargeGuardHelper                   root helper. Small. No policy logic.

Swift packages
  ChargeGuardCore     Config, Status, policy (port of policy.ts), place resolve. Pure. No I/O.
  ChargeGuardSensors  IOKit battery data, temperature, clamshell, router MAC.
  ChargeGuardXPC      the protocol between the app and the helper.
```

### 5.1 Where each job runs

| Job | Today | Native app |
|---|---|---|
| Policy loop, 30 s and on events | Bun daemon, launchd agent | UI app, started at login with `SMAppService.mainApp` |
| Charge limit | `sudo cg-helper limit` with `pmset` | Helper over XPC |
| Adapter, LED | `sudo cg-helper` with the `smc` binary | Helper over XPC, with IOKit `AppleSMC` writes |
| Low Power Mode | `sudo cg-helper lowpower` | Helper over XPC |
| Battery temperature | `smc` binary | IOKit `AppleSMC` read in the app. No root needed. |
| Place | `route` and `arp` each 30 s | Same method from Swift, only on events. See 5.3. |
| Sleep and wake | sleepwatcher hooks | `NSWorkspace` sleep and wake notifications |
| Menu bar | SwiftBar plugin | `MenuBarExtra` in SwiftUI |
| Desktop widget | JXA host with WKWebView | Native window at the same level, with SwiftUI. See D3. |
| Notifications | `osascript` | `UNUserNotificationCenter` |
| Shortcuts | `cg` CLI | App Intents. `cg` stays as an option. |
| Keep awake | `caffeinate -i` | `IOPMAssertionCreateWithName` |

### 5.2 Helper safety

- The helper accepts XPC calls only from a client signed with the team ID of the app. It uses `NSXPCConnection.setCodeSigningRequirement`.
- The helper has a fixed list of calls: `setLimit(Int)`, `setAdapter(Bool)`, `setLed(Led)`, `setLowPower(Bool)`, `failSafe()`. There is no generic "run command" call.
- Watchdog: the app sends a heartbeat every 30 s. If the helper gets no heartbeat for 90 s, it does `failSafe()`. That sets the adapter on and the LED to system. This replaces the SIGTERM handler in `src/daemon.ts`.
- The helper never turns the adapter off below 10%, also if the app asks. This keeps PRD rule R9.

### 5.3 Place check on events, not on a timer

ChargeGuard does not use Location Services or GPS. It reads the MAC address of the router.
Today the daemon reads the router each 30 s. The app reads it only when the place can change:

- The network changes. `NWPathMonitor` and the `SCDynamicStore` key for the IPv4 default route send an event. There is no poll.
- The charger is connected.
- The Mac wakes from sleep.
- The user opens the widget, or clicks "Use current Wi-Fi".

On battery power, the place has no effect on charging. So the app reads no router while the charger is off.
The app keeps the last router MAC and gateway IP. A new read happens only if the gateway IP changes.

The battery data uses events too. IOKit power-source notifications report percent and AC changes.
The 30 s loop stays only for tasks with a time limit: office hours, schedule, calibration, and heat.
On battery power with no task, the loop stops. Requirement N5 measures this.

### 5.4 Data

- Config: `~/Library/Application Support/ChargeGuard/config.json`. It has the same schema as today, and `version` goes to 2.
- On first start, the app imports `~/.chargeguard/config.json` if it exists. It does not delete the old folder.
- The default config has no routers. The router MAC in `src/config.ts:34` must not ship.
- Status is in memory. The app does not write `status.json` for each 30 s update. The CLI asks the app over XPC.

## 6. Data contracts

- `Config` and `Status` in Swift copy `src/types.ts` field by field. Swift `Codable` reads the current JSON files.
- Policy parity: one test reads each file in `tests/fixtures/`. It runs the Swift policy and compares the result with the TypeScript policy result, which is stored as JSON. The CI updates the stored results from `bun test` on the runner.
- XPC protocol: section 5.2. Each call returns `Result<Void, HelperError>`, and `HelperError` holds text for the log.

## 7. Milestones

| ID | Milestone | Output | Done when |
|---|---|---|---|
| M0 | Spike, 2 to 3 days | A small signed test app with a helper | SMAppService installs the helper after one approval. The helper writes `CHIE` and the LED from Swift. `pmset battlimit` works from the helper. Reports A2, A3, A4, D4. |
| M1 | Core port | `ChargeGuardCore` package | All cases in `policy.test.ts` and `config.test.ts` pass in Swift. The parity test passes for all fixtures. |
| M2 | Helper and XPC | Helper, XPC protocol, watchdog | Kill the app during a discharge. Within 90 s, the adapter is on. |
| M3 | App shell | Menu bar, setup screens, Settings window | A new user finishes setup without Terminal. See USER-JOURNEYS.md, J1. |
| M4 | Desktop widget | SwiftUI widget with themes, size, panel height, and corner | It has the same states as `tests/fixtures/status-*.json` and the same controls as the current widget. |
| M5 | Events and tasks | Plug-in notification, sleep and wake, office hours, schedule, calibration, discharge | PRD checks A1 to A7 pass on hardware. |
| M6 | Migration and uninstall | Import of the old config, a stop of the old launchd agents, an Uninstall button | The old Bun version stops, and the app takes over without a charge gap. Uninstall leaves charging on. |
| M7 | Release | Developer ID signing, notarization, DMG, Sparkle updates, CI | A clean Mac with another user account installs from the DMG with no warnings. |
| M8 | Beta | 2 or 3 other users for 2 weeks | No fail-safe bugs. Crash reports are reviewed. |

The current Bun version stays in use until M6 is done.

## 8. Later (P2)

- Wi-Fi name matching. A signed app can ask for Location permission, and then CoreWLAN gives the SSID. The router MAC stays the default, because one Wi-Fi name can exist in many buildings.
- A WidgetKit widget for the desktop and Notification Center. WidgetKit has a refresh budget and only App Intents buttons, so it is a second widget, not a replacement.
- Battery history graph (PRD R22).

## 9. Risks

| Risk | Effect | Action |
|---|---|---|
| No build host (D1) | No milestone can start. | Decide D1 first. |
| No developer account (D2) | Other users see warnings. The helper install can fail. | M0 tests an ad-hoc build. |
| A macOS update changes SMC keys | Discharge and LED stop working. | The helper reads back each write. The app shows "Not supported on this Mac" and keeps the charge limit. |
| The SMC key list comes from the open source `battery` project | License duties | Check the license before code is copied. Write the IOKit calls ourselves. |
| A helper bug leaves the adapter off | The battery drains on AC. | Watchdog, the 10% floor, and a fail-safe at helper start. |
| Two versions run at the same time during migration | Two loops fight over the limit. | M6 stops the Bun agents before the app loop starts. |

## 10. Acceptance criteria for v1

- N1: A user on a clean Mac installs from the DMG and finishes setup in under 3 minutes, with no Terminal.
- N2: All P0 checks in `docs/PRD.md` (A1 to A7) pass with the app. A8 passes as Swift tests in CI.
- N3: Quit the app, kill the helper, or uninstall: charging is on within 90 s.
- N4: All settings that `cg set` has today are in the Settings window or the widget.
- N5: The app and the helper use less than 60 MB of memory together, and less than 1% CPU on average.
  On battery power with no task, the app starts no process and reads no router. Activity Monitor shows "Energy Impact" near 0.
- N6: VoiceOver can reach every control in the widget, the menu, and Settings.
