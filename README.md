# Pilot

A local bridge so any agent harness can drive a Chrome profile — clicks, keys,
typing, tab management, and small screenshots — without stealing your window.

Three pieces:

| Piece | What it is |
| --- | --- |
| `extension/` | MV3 Chrome extension. The popup's **Connect** button is the handshake: a profile only appears on the relay after you click it. |
| `server.js` | The relay. One relay serves every Chrome profile on the machine. `node server.js`. |
| `cli.js` | Harness-side client. `node cli.js '{"action":"snap"}'`. |

Plus `ocr.swift` — an on-device macOS Vision OCR tool (`swiftc -O ocr.swift -o ocr`)
that reads screenshot text with **zero API keys**, which is how the harness reads
Pilot screenshots even when a vision provider key is unavailable.

## Why a handshake

The relay is localhost-only and has no passwords. The human is the password:
you click **Connect** in the popup of whichever Chrome profile you want driven,
and that profile shows up on the relay. Click **Disconnect** (or close Chrome)
and it's gone. Nothing reconnects by itself.

Use different Chrome profiles for different jobs — give each one a distinct
profile name in the Pilot options page, and the harness targets the right one:

```sh
node cli.js '{"action":"click","text":"Deploy"}' --profile work
node cli.js '{"action":"shot"}' --profile personal
```

## Quick start

```sh
# 1. Run the relay
node server.js

# 2. Load the extension (chrome://extensions → Developer mode → Load unpacked)
#    point it at the extension/ folder. Pin Pilot to the toolbar.

# 3. Click Connect in the Pilot popup. That's the handshake.

# 4. Drive it from the CLI
node cli.js --status
node cli.js '{"action":"snap"}'
node cli.js '{"action":"click","text":"Submit"}'
node cli.js '{"action":"shot"}' --out /tmp/page.jpg
./ocr /tmp/page.jpg
```

## Background tabs, no focus stealing

Pilot runs commands via `chrome.scripting.executeScript`, which works on
inactive tabs — the harness can click, type, and snapshot a background tab
while you work in another window. It only brings the driven tab forward if you
enable **"Bring the driven tab forward on every action"** in the options page.

Driven tabs get a red **Harness** tab group so it's obvious what the agent is
touching. Screenshots of background tabs use the Chrome DevTools Protocol, so
they work without focusing the tab.

## CLI reference

```sh
node cli.js --status                                  # who is connected
node cli.js --sessions                                # every agent's tab pin (~/.pilot/session.json)
```

### Sessions — one tab per agent

Every agent passes `--session NAME` (use your agent id, e.g. `$DSH_SESSION_ID`).
The first command with a new session claims a dedicated background tab and pins
it on disk; later commands drive that same tab, so two agents can never hijack
each other. Same window = separate tabs; `--new-window` / `--window ID` = separate
windows; `--profile NAME` = separate Chrome profiles.

```sh
node cli.js '{"action":"claim"}' --session NAME --new-window    # claim, in a new window
node cli.js '{"action":"release"}' --session NAME               # close the pinned tab, forget it
node cli.js '{"action":"guard"}' --session NAME                 # pull the tab back if it drifted
node cli.js '{"action":"snap"}' --session NAME --profile work   # drive it in another profile
```

Every other command also takes `--session NAME` (default `default` — omit only
when nothing else shares the profile). `--tab ID` overrides the pin for one call.

```sh
node cli.js '{"action":"tabs"}'                                  # every tab: url, title, group, window, pinned, muted, active
node cli.js '{"action":"windows"}'                    # every window: focused, type, state, size
node cli.js '{"action":"groups"}'                     # every tab group: title, color, window, collapsed
node cli.js '{"action":"activeTab"}'                  # what YOU are looking at right now (so the agent avoids it)
node cli.js '{"action":"tabInfo","tabId":123}'        # one tab's details

# Tab management — target the driven tab unless you pass tabId
node cli.js '{"action":"newHarnessTab","url":"https://x"}'  # background tab in the Harness group
node cli.js '{"action":"closeTab","tabId":123}'       # close a tab
node cli.js '{"action":"duplicate","tabId":123}'      # duplicate a tab
node cli.js '{"action":"pin","tabId":123}' / '{"action":"unpin","tabId":123}'
node cli.js '{"action":"reloadTab","tabId":123}'      # reload a tab

# Read a page — deep
node cli.js '{"action":"snap"}'                       # quick snapshot (title, url, text, clickable items)
node cli.js '{"action":"page"}'                       # deep: meta, headings, links, forms, images, text
node cli.js '{"action":"eval","code":"document.title"}'      # run JS in the page, JSON-safe result
node cli.js '{"action":"scroll","dy":800}'            # scroll; returns new position
node cli.js '{"action":"inspect","x":100,"y":200}'    # what element is under a point (tag, text, rect, attrs)

# Interact
node cli.js '{"action":"click","sel":"button.x"}'     # click by CSS selector
node cli.js '{"action":"clickText","text":"Save"}'    # click by visible text
node cli.js '{"action":"clickXY","x":100,"y":200}'    # click at coordinates
node cli.js '{"action":"type","text":"hello"}'        # type into the focused composer
node cli.js '{"action":"type","sel":"#msg","text":"hi"}'
node cli.js '{"action":"key","key":"Enter"}'
node cli.js '{"action":"fill","sel":"#name","value":"Ada"}'
node cli.js '{"action":"form"}'                       # inputs/selects/radios in the open dialog
node cli.js '{"action":"dialog"}'                     # open dialog text
node cli.js '{"action":"findText","text":"Save"}'     # locate text on the page
node cli.js '{"action":"navigate","url":"https://x"}' # go to a URL
node cli.js '{"action":"shot"}'                       # screenshot → saved to ~/.pilot/shots/
node cli.js '{"action":"shot"}' --out /tmp/x.jpg
node cli.js '{"action":"reload"}'                     # reload the extension
```

### Tab targeting rules

- **Via the CLI with `--session NAME`** (the normal path) → your pinned tab,
  claimed on first use. Two agents with different session names drive different
  tabs in the same window and never touch each other's (or yours).
- **`--tab ID` or an inline `tabId`** → that exact tab, once.
- **No session, no `tabId`** → Pilot drives a Harness-grouped background tab
  (finds one or creates a fresh background tab). It **never** hijacks your
  active tab.
- Read-only actions (`tabs`, `windows`, `groups`, `activeTab`, `snap`, `page`,
  `eval`, `scroll`, `inspect`, `shot`) never bring a tab forward, even with
  "bring forward" enabled. Only real interactions (`click`, `type`, `key`,
  `navigate`, …) do, and only when you opted in.

Every command accepts `--profile NAME` to pick which Chrome profile handles it.
Commands sent to a profile that isn't connected are queued on the relay and
delivered the moment that profile handshakes.

## Screenshots

`shot` returns a small image (downscaled to the configured max width, JPEG by
default) — small enough for the harness to read fast. The CLI writes it to
`~/.pilot/shots/` (or `--out`) and prints the path. Read it with:

```sh
./ocr ~/.pilot/shots/12345.png          # plain text lines
./ocr ~/.pilot/shots/12345.png --json   # per-line boxes + confidence
```

## Settings

Pilot options page (right-click the icon → Options):

- **Profile name** — how this Chrome profile appears on the relay
- **Relay URL** / **Harness URL** — where the relay and harness listen
- **Auto-start the relay on Connect** — on by default
- **Driven-tab group name and color** — the group Pilot puts driven tabs in
  (default `Harness` / red); the agent targets tabs in this group
- **Bring the driven tab forward on every action** — off by default (background mode)
- **Screenshot method** — auto / CDP always / visible tab only
- **Screenshot max width** and **format**

## Tests

```sh
npm test        # node:test — relay handshake, multi-profile, queuing, status
```

## Install (unpacked)

1. `git clone https://github.com/FatherMarz/pilot.git`
2. `open chrome://extensions`, turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin Pilot, click Connect, done.

## License

MIT
