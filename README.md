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
node cli.js '{"action":"snap"}'                       # page snapshot (title, url, text, clickable items)
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
node cli.js '{"action":"tabs"}'                       # list all tabs
node cli.js '{"action":"navigate","url":"https://x"}' # go to a URL
node cli.js '{"action":"shot"}'                       # screenshot → saved to ~/.pilot/shots/
node cli.js '{"action":"shot"}' --out /tmp/x.jpg
node cli.js '{"action":"reload"}'                     # reload the extension
```

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
- **Relay URL** — where the relay listens
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
