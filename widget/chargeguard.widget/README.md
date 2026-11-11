# ChargeGuard widget

This widget shows the battery state on the desktop. It runs standalone by default. It does not need Übersicht.
It reads `~/.chargeguard/status.json`. It changes settings only through the `cg` command.

The standalone host is `widget/standalone/host.js`, a JXA script. It opens a transparent window without borders.
The window stays above the desktop icons and below normal windows. It shows on all Spaces.
It sits in a corner of the primary screen. That is the screen with the menu bar.
The host loads the same `index.jsx` in a WKWebView through a small `uebersicht` shim with `run`, `css`, and `React`.
React 18.3.1 and Babel standalone 7.24.7 are local files in `widget/standalone/vendor`. The widget needs no network.

The window resizes to fit the widget, so you can click the rest of the desktop.
Clicks on the widget work directly. You do not need an interaction shortcut.

## Look and position

Open Settings in the widget. The "Widget" section is at the top. You can also use `cg set`.

| Setting | Values | Default | Command example |
|---|---|---|---|
| Theme | `auto`, `dark`, `light`, `glass`, `graphite`, `midnight`, `sand`, `contrast` | `auto` | `cg set widget.theme midnight` |
| Size | 70 to 150, in percent, in steps of 5 | 100 | `cg set widget.scale 120` |
| Panel height | 40 to 100, in percent of the screen height | 85 | `cg set widget.panelHeight 70` |
| Position | `top-left`, `top-right`, `bottom-left`, `bottom-right` | `bottom-left` | `cg set widget.corner top-right` |

- Auto follows the macOS appearance. Glass is more transparent. Contrast has black and white with strong lines.
- In Settings, use − and + to change the size by 5%. Hold Shift to change it by 20%.
- Panel height is the most screen height that the widget uses with Settings open. The panel scrolls if it needs more.
- The widget changes in about 2 s. In a top corner, the settings panel opens below the card.

NOTE: In Übersicht, the theme, size, and panel height work. The position stays at the bottom left.

## Place

ChargeGuard finds the place by the router. A place can have more than one router.
To set the place by hand, open Settings and choose Home, Office, or Away in "Places > Place".
You can also run `cg place use home`. The values are `auto`, `home`, `office`, and `away`.

A place set by hand stays until you choose Auto. The card shows "set by hand" next to the place name.

## Install

1. Run the installer from the repo root: `bash scripts/install.sh`.
   It installs the standalone widget and removes the Übersicht link.
2. Make sure the daemon runs. The widget shows "ChargeGuard stopped" if it does not. Click "Start ChargeGuard".

The launchd agent `com.chargeguard.widget` starts the widget at login. It also restarts the widget if it stops.
The log is `~/.chargeguard/widget.log`.

To start the widget by hand, run this from the repo root:

`osascript -l JavaScript widget/standalone/host.js "$PWD/widget"`

To restart the widget after an edit, run this:

`launchctl kickstart -k gui/$(id -u)/com.chargeguard.widget`

The widget needs `~/.chargeguard/bin/cg`. The installer script puts it there.

CAUTION: Do not run Übersicht and the standalone widget at the same time. If both run, two widgets show.

## Install in Übersicht (option)

The widget also runs in Übersicht 1.6.

1. Run the installer with the Übersicht option: `CG_WIDGET=ubersicht bash scripts/install.sh`.
   Or link the widget folder into Übersicht yourself:
   `ln -s ~/NE/chargeguard/widget/chargeguard.widget "$HOME/Library/Application Support/Übersicht/widgets/chargeguard.widget"`
2. Open the Übersicht menu. Choose "Refresh All Widgets".
3. Turn on interaction. Open Übersicht preferences. Enable "Interaction shortcut", or use the shortcut to click the widget.

## What the widget shows

- Place chip: Home, Office, Away, or No network.
- Big percent, mode word, and an icon. Color is never the only sign.
- Battery bar with a target tick and a sail band. A wave moves while the Mac charges.
- Summary line, next-change line, and an office day timeline.
- Footer: temperature, charger power ("slow" under 30 W), battery health.
- Buttons: top up, discharge, pause or resume.
- Plug-in banner for 20 s. Unplug banner for 10 s. The widget builds the text from the status file.

## State colors

| State | Color |
|---|---|
| Holding, sailing | green |
| Charging | yellow |
| Top-up | blue |
| Discharging, calibrating | teal |
| Heat pause, error | red |
| Paused, on battery | gray |

## Special states

- No status file: "Waiting for ChargeGuard" and a Start button.
- Status older than 90 s: "ChargeGuard stopped" and a Start button.
- Helper not installed: "One-time setup needed". Run `sudo bash ~/NE/chargeguard/scripts/install-root.sh` in Terminal. "Copy command" copies it.
- No router: "No network. Charges to 100%."
- Unknown router: "Away. Charges to 100%." with "Save as Home" and "Save as Office".
- "Applying…" shows until `health.appliedLimit` equals `decision.nativeLimit`. A value of null means 100.

## Settings drawer

Click the gear. The drawer has these sections: Places, Charge limit, Office hours, Protection, MagSafe LED, Calibration, Schedule.
The widget has no text fields. Use the steppers, chips, and switches. Hold Shift on the limit stepper for steps of 5.
Discharge and calibration need two taps. The second tap must come within 5 s.

A control shows a dim state and a spinner until the next status shows the change. It stops after 10 s.

## Motion

With "Reduce motion" on, the widget has no wave, no ring draw, and no scale. It uses fades only.

## Preview in Chrome

Run this in the repo root, on a server host:

`python3 -m http.server 8080`

Open `http://<host>:8080/widget/preview/index.html?fixture=home-holding&theme=dark`.

Query options:

- `fixture`: a name from `tests/fixtures/status-<name>.json`, or `empty`.
- `theme`: `dark` or `light`.
- `drawer=1`: open the settings drawer.
- `now`: an ISO time for the fake clock, for example `2026-11-11T15:45:00+07:00`.
- `freeze=1`: stop the fake clock.

The preview does not run commands. It prints them in the log box.
The page loads React and Babel from cdnjs, so it needs internet.

## Files

- `index.jsx`: the widget. It reads the clock through `nowMs()`. The preview can set `window.__CG_NOW__`.
