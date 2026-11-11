# ChargeGuard verification

Date: 2026-11-11. All commands ran on the runner. Nothing ran on the Mac.

## Environment

- Host: runner 103.105.79.121, Ubuntu 22.04 LTS, kernel 6.2.16-3-pve.
- Work dir: /mnt/hdd-work/chargeguard.
- Bun: 1.2.18 at /mnt/hdd-work/bun/bin/bun.
- TypeScript (tsc): 5.8.3.
- @types/bun: 1.2.18.
- `unzip` was missing. It was installed with apt-get.

## Commands

```
rsync -az --delete --exclude .git --exclude node_modules --exclude widget --exclude tests/fixtures \
  /Users/rangga-sa/NE/chargeguard/ root@103.105.79.121:/mnt/hdd-work/chargeguard/
ssh root@103.105.79.121
export PATH=/mnt/hdd-work/bun/bin:$PATH
cd /mnt/hdd-work/chargeguard
bun install
bun test
bunx tsc --noEmit -p .
```

## Results

First run, before fixes:

- `bun test`: 116 pass, 1 fail, 117 tests, 5 files.
- Failed test: `renderMenubar > holding: battery icon, green, percent, limit check`.
- `tsc`: 1 error. `src/policy.ts(417,76): TS2367`.

Final run, after fixes:

```
 117 pass
 0 fail
 385 expect() calls
Ran 117 tests across 5 files.
```

- `bun test` ran 3 times. All 3 runs gave 117 pass, 0 fail.
- `bunx tsc --noEmit -p .`: no output, exit code 0.

## Fixes

- `src/policy.ts`: removed the `finalMode === "error"` check in the LED step. The type of `finalMode` cannot be "error" there. The policy never sets that mode. Only the daemon fail-safe sets it.
- `tests/menubar.test.ts`: the test was wrong. It found the header line `80% | ...` first and not the menu line in the limit section. The test now looks only at the lines after `---`. No assertion was removed or weakened.
- `tests/cli-smoke.test.ts`: new. It starts `src/cli.ts` with a temp HOME. It checks that `help` and `menubar` exit 0 and that an unknown command exits 2.
- File mode: `chmod +x` on `bin/cg`, `hooks/*`, `swiftbar/*.sh`, `scripts/*.sh`, `scripts/cg-helper`.

`src/types.ts` was not changed.

## Integration review (read only)

- Imports in `cli.ts`, `daemon.ts`, `menubar.ts`, `net.ts` match the exports of `config.ts`, `policy.ts`, `helper.ts`, `sensors.ts`, `smc.ts`. `tsc` confirms this.
- The daemon applies `nativeLimit`, `adapter`, `led`, and `lowPower` through `helper.ts`. It writes each value only when the value changes.
- The SIGTERM and SIGINT handler sets the adapter on and the LED to system, then writes `status.json` with `daemon: false`.
- `status.json` is built as the `Status` type. `tsc` confirms this.
- `bin/cg` uses `/Users/rangga-sa/.bun/bin/bun`. The launchd plist uses that path and `/Users/rangga-sa/.chargeguard/app/src/cli.ts`.
- The CLI appends one line per command to `inbox.jsonl`. The daemon renames the file to `inbox.processing` and then reads it. A new append after the rename makes a new file. This is safe in normal use.

## Open risks

- The inbox has two small race windows. A CLI append that starts before the rename and ends after the read can be lost. The crash-recovery merge in `processInbox` can lose a line that arrives between the read and the unlink. The chance is very low. A second rename step closes both windows.
- No test ran on macOS. The code for `pmset`, `smc`, `sudo`, `launchctl`, `osascript`, and `caffeinate` is not tested on real hardware. Only the parsers have tests.
- The `daemon` loop, the `applyHardware` logic, and the signal handler have no automated test.
- Widget files are not part of this run.
- The scripts `install.sh` and `install-root.sh` were read but not run.

## Install on the Mac (planner, 2026-11-11)

| Check | Command | Result |
|---|---|---|
| Root install | `install-root.sh` through a macOS admin dialog | smc SHA-256 OK, cg-helper root:wheel 755, `/etc/sudoers.d/chargeguard` 440, `visudo -cf` OK |
| Sudo scope | `sudo -n -l /usr/local/libexec/chargeguard/cg-helper` | OK |
| Doctor | `cg doctor` | All OK except "office set: 0 routers" (expected until the user is at the office) |
| A1 Home limit | `cg status` | `place=home target=80 mode=holding`; `pmset -g battlimit` = 80; battery drains on AC (-10 W) |
| Daemon restart | `install.sh` twice | Running both times after the launchd wait fix |
| SIGTERM fail-safe | log after bootout | "Fail-safe: adapter on, LED system" |
| Widget live | Übersicht page `http://127.0.0.1:41416/` | Renders live status: Home, 95%, "Lowering to 80%", 7 W charger (slow) |
| Tests after fixes | runner `bun test`, `tsc --noEmit` | 118 pass, 0 fail; tsc OK |

Fixes by the planner: preview reducer argument order; drawer max-height; "above limit" text (policy + widget + test); install.sh waits for launchd bootout.

Not tested on hardware yet: plug-in notification (A4), office hours top-up (A3), heat (A6), discharge, calibration, sleep hooks, SwiftBar menu (needs a visual check by the user).
Known minor risk: inbox race window between CLI append and daemon rename (a lost command needs one more click).
