# ChargeGuard native Mac app: user journeys

Status: draft, 2026-11-11. These journeys belong to `PLAN.md`.

Actors:

- New user: has a MacBook with Apple Silicon. Does not use Terminal.
- Current user: has the Bun version of ChargeGuard installed.

## J1. Install and first setup (new user)

Trigger: the user gets `ChargeGuard.dmg` from a link.
Prerequisites: an Apple Silicon Mac with the lowest macOS version from D4. An admin account.

| Step | User action | System response |
|---|---|---|
| 1 | Opens the DMG. Drags the app to Applications. | Finder copies the app. |
| 2 | Opens ChargeGuard. | Gatekeeper opens it with no warning. The app is signed and notarized. The welcome screen shows what the app does. |
| 3 | Clicks "Continue". | The app registers the helper. macOS asks the user to approve it in System Settings. The app shows a button that opens the correct page. |
| 4 | Turns on ChargeGuard in Login Items. | The app finds the approval within 2 s and shows a check mark. |
| 5 | Chooses a charge limit. 80% is the default. | The app sets the native limit through the helper. |
| 6 | Answers "Is this network your Home?" with Yes, Office, or Skip. | The app saves the router for that place. |
| 7 | Chooses the widget corner and theme, or keeps the defaults. | The widget shows on the desktop. The menu bar icon shows. |
| 8 | Allows notifications. | macOS shows its prompt. Setup ends. |

Success evidence: the widget shows the place and "Holding at 80%" or "Charging to 80%". Terminal was not used.

Other paths:

- First time on an unsupported Mac: step 2 shows "This Mac is not supported" and the reason. The app installs nothing.
- Returning user: the app opens to the menu bar only. Setup does not show again.
- Error: the helper does not answer. The app shows "Charge control is off", a "Try again" button, and a link to the log. The Mac charges as normal.
- Permission denied: the user does not approve the helper. The app works in "read-only" mode. It shows the battery state and the place, but it does not change charging. A banner explains how to approve the helper later.
- Notifications denied: the widget banners still work. Settings shows that notifications are off.

## J2. Daily use: plug in at the office

Trigger: the user connects the charger at the office.
Prerequisites: J1 is done, and the office router is saved.

| Step | User action | System response |
|---|---|---|
| 1 | Connects the charger. | IOKit sends an AC event. The app reads the router one time. See PLAN 5.3. |
| 2 | None. | The app finds "Office". It sends a notification: "Office. Holds at 80%. Charges to 100% from 15:30." The widget shows the banner for 20 s. |
| 3 | At 15:30, none. | The app sets the limit to 100%. The widget timeline shows the top-up. |
| 4 | Disconnects the charger at 17:05. | The app stops the place checks until the next plug-in. |

Success evidence: the battery is at 100% at 17:00. The log shows one router read at plug-in, not one each 30 s.

Other paths:

- Error: no network at plug-in. The place is "No network", and the target is 100%. When the network comes back, the app reads the router again.
- The user is at a new office: the place is "Away". The widget shows "Save as Office".

## J3. Set the place by hand

Trigger: the router is not saved, or the user wants another place for a day.

| Step | User action | System response |
|---|---|---|
| 1 | Clicks the menu bar icon, or the gear on the widget. | The menu or the Settings panel opens. |
| 2 | In "Place", chooses Home, Office, or Away. | The target changes in 2 s. The widget shows "set by hand". |
| 3 | Later, chooses "Auto". | The app reads the router again and uses the saved places. |

Success evidence: the place stays as chosen after sleep, a network change, and a restart.

## J4. Move from the Bun version (current user)

Trigger: the current user installs the native app.
Prerequisites: `~/.chargeguard/config.json` exists.

| Step | User action | System response |
|---|---|---|
| 1 | Opens the app for the first time. | The app finds the old version. It shows "Import settings from the old version?". |
| 2 | Clicks "Import". | The app copies the config. It stops the old launchd agents `com.chargeguard.daemon` and `com.chargeguard.widget`. Then it starts its own loop. |
| 3 | Approves the helper, as in J1 step 3. | The new helper takes over. |
| 4 | Optional: clicks "Remove old version". | The app removes the old launchd files and the sudoers rule. It asks for the admin password for the sudoers rule. |

Success evidence: the limit stays at the same value during the move. Only one widget shows.

Other paths:

- Error: the old agents do not stop. The app does not start its loop. It shows the command that stops them.

## J5. Uninstall

Trigger: the user wants to remove ChargeGuard.

| Step | User action | System response |
|---|---|---|
| 1 | Opens Settings > About. Clicks "Uninstall ChargeGuard". | The app asks "Keep the 80% limit in macOS, or go back to 100%?" |
| 2 | Chooses an option. | The helper sets the adapter on, the LED to system, and the limit as chosen. The app removes the helper and the login item. Then it quits. |
| 3 | Drags the app to the Trash. | Nothing of ChargeGuard runs. |

Success evidence: the Mac charges as normal. No ChargeGuard process runs.

Other paths:

- The user drags the app to the Trash first: the helper finds that the app is missing at the next heartbeat check. It does the fail-safe and stops.
