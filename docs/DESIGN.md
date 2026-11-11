# ChargeGuard design

Source: PRD.md, R5 and R21. Approved 2026-11-11.

## Design plan

Primary surface: **Monitor**, with a **Configure** drawer. The user glances at the desktop. The user must see in one second: percent, what the Mac does now, and why.

### Placement and size

- Bottom-left of the desktop, 16 px from the edges, 360 px wide. Compact mode (pill, 200 px) is a setting.
- Übersicht on the desktop layer. Clickable controls. No text inputs, because desktop-layer keyboard focus is not reliable. Use steppers, chips, and segmented controls.

### Visual tokens

- Surface: dark `rgba(22,22,24,0.78)` + `backdrop-filter: blur(24px) saturate(140%)`, 1 px border `rgba(255,255,255,0.08)`, radius 22 px. Light appearance through `prefers-color-scheme`. The fill is solid enough for WCAG AA text contrast on any wallpaper.
- Type: SF Pro Text; numbers in SF Pro Rounded, `tabular-nums`. Percent 44 px / 600. Body 13 px. Caption 11 px.
- State colors (Apple system colors, each paired with an icon and a word, never color only):
  - Holding: green `#30D158`
  - Charging: yellow `#FFD60A`
  - Top-up / office top-up: blue `#0A84FF`
  - Discharging / calibrating: teal `#64D2FF`
  - Heat pause / error: red `#FF453A`
  - Away / paused: gray `#8E8E93`
- Spacing 4 px grid. Motion 200 to 400 ms ease-out. Under `prefers-reduced-motion`, use fades only.

### Main card

```
┌────────────────────────────────────────────┐
│ ⌂ Home  ·  router saved                  ⚙ │
│                                            │
│  78%      ⚡ Charging to 80%               │
│  ▕██████████████████▒▒|░░░░░░░░▏          │
│            sail 75 ─┘ └─ limit 80          │
│  Stops at 80%. Starts again at 75%.        │
│ ────────────────────────────────────────── │
│ 31 °C   ·   7 W charger (slow)   ·  100%   │
│ [ Top up to 100% ] [ Discharge ] [ Pause ] │
└────────────────────────────────────────────┘
```

- Battery bar: the fill uses the state color. A soft liquid wave moves in the fill while charging. The wave stops when holding. A tick marks the target. A shaded band shows the sail zone.
- Office card adds a day timeline: `08:00 ───●now────▮top-up 15:30──── 17:00`. The `next` line says "Top-up starts 15:30. Full by about 17:00."
- If the charger is slow and cannot reach 100% before the end, the line says so and suggests a longer lead time.
- Away card: "Away · charges to 100%" and two buttons: "Save as Home", "Save as Office". This is also the first-time empty state.

### Plug-in moment (R5)

- On AC connect, the card grows 8 px and a ring draws around the battery icon (600 ms).
- Banner: "Plugged in at Home. I will stop at 80%." or "Plugged in at Office. Holds 80% until 15:30, then charges to 100% for 17:00."
- The banner stays 20 s, then fades. A macOS notification shows the same text.
- On unplug: "On battery · 80% · about 6 h left" for 10 s.

### Settings drawer (⚙)

Sections, each with short help text:

1. **Places**: Home and Office rows. Each row shows saved routers ("1 router, 9c:71:…:9f"), a "Use current Wi-Fi" button, and "Forget". A banner shows the current router and whether it matches.
2. **Charge limit**: segmented 80 / 90 / 100 plus a −/+ stepper (50 to 100). Hint: "80% is best for battery life if the Mac is often on the charger."
3. **Office hours**: day chips M T W T F S S, start and end steppers (15-min steps), lead time 30 / 60 / 90 / 120 min.
4. **Protection**: heat (max °C), sailing (%), stop charging when sleeping, sleep control, auto discharge, discharge in clamshell, Low Power Mode below X%.
5. **MagSafe LED**: on/off.
6. **Calibration**: last run date, "Start calibration" (with a 2-step confirm in the widget, not a browser dialog).
7. **Schedule**: list of rules, add with chips (days) + time stepper + action segment.

### States the widget must cover

- Daemon not running → "ChargeGuard stopped" + "Start" button (runs `launchctl kickstart`).
- Setup not complete (no smc or no sudoers rule) → "One-time setup needed" + the exact command to copy.
- No Wi-Fi / no gateway → "No network · charges to 100%".
- Status file older than 90 s → stale badge.
- Every button shows a pending state until the next status update confirms the change.

### Menu bar (SwiftBar)

- Icon from config: battery glyph + %, % only, bolt, or leaf. Color by state.
- Dropdown sections (order from config): status, place, limit (80/90/100), actions (top up, discharge, pause), office hours, schedule, open settings.

### Notifications

`osascript -e 'display notification …'`. Events: plug-in, unplug, office top-up start, reached 100% before going home, heat pause, calibration step. Each event can be turned off.

