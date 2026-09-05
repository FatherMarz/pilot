# Pilot

A local bridge so any agent harness can drive a Chrome profile — clicks, keys,
typing, form fills, tab management, and small screenshots — without stealing
your window.

Three pieces:

| Piece | What it is |
| --- | --- |
| `extension/` | MV3 Chrome extension. Auto-connects to the relay on browser start; the popup shows the state and can disconnect. |
| `server.js` | The relay. One relay serves every Chrome profile on the machine. `node server.js`. |
| `cli.js` | Harness-side client. `node cli.js '{"action":"snap"}'`. Run `node cli.js '{"action":"help"}'` for the full cheat sheet. |

Plus `ocr.swift` — an on-device macOS Vision OCR tool (`swiftc -O ocr.swift -o ocr`)
that reads screenshot text with **zero API keys**, which is how a harness reads
Pilot screenshots even when a vision provider key is unavailable.

## Trusted input

Clicks and keys go through the Chrome debugger (`Input.dispatch*`), so pages
receive **real user input**: `event.isTrusted === true`, default actions run,
same as a human click. Element targeting stays semantic — `clickN`/`clickText`
resolve the element, scroll it into view, and the debugger clicks its center —
so a shifted layout cannot make it miss.

Pilot never disturbs you. Debugger input needs the tab rendered (active in its
window), so:

- Tab in an **unfocused window** (the usual dedicated agent window) → Pilot
  activates it there and clicks trusted. Your focus is untouched.
- Tab in the **window you are working in** → it stays a background tab and
  gets simulated events instead (those work fine unfocused).
- Debugger taken, or element covered by an overlay → simulated events.

Every reply's `via` field says which path ran: `cdp`, `synthetic-background`,
`synthetic-covered`, or `synthetic-fallback`.

Hover-revealed controls (a "..." that only appears on mouseenter) are handled
automatically: a trusted click first glides the mouse onto the element, lets the
hover state settle, re-measures the element's *new* position, then clicks — so it
never clicks the stale pre-hover spot. For hovering *without* clicking, use
`hover` / `hoverXY`.

## Quick start

```sh
# 1. Load the extension (chrome://extensions → Developer mode → Load unpacked)
#    point it at the extension/ folder. Pin Pilot to the toolbar.

# 2. Run the relay (a harness normally starts it for you)
node server.js

# 3. Drive it
node cli.js --status
node cli.js '{"action":"claim"}' --session myjob
node cli.js '{"action":"navigate","url":"https://example.com"}' --session myjob
node cli.js '{"action":"snap"}' --session myjob
node cli.js '{"action":"clickN","n":3}' --session myjob
```

The extension connects on browser start (turn **Auto-connect** off in Options
for a strictly manual popup handshake). After editing extension code, send
`{"action":"reload"}` — Chrome does not reload unpacked extension code on
browser restart.

## The loop a driving model follows

`snap` returns the page text plus a **numbered** list of clickable items;
`clickN` clicks by that number; snap again confirms. No selectors, no
coordinates, no exact spelling needed. Every reply has `ok`; failures carry
recovery data — a failed click returns `visibleTexts`, a failed fill returns
`fields`, a failed select fill returns `options`, toggles report `checkedNow`.

## CLI reference

```sh
node cli.js --status         # who is connected
node cli.js --sessions       # every agent's tab pin (~/.pilot/session.json)
node cli.js '{"action":"help"}'   # full command list with examples
```

### Sessions — one tab per agent

Every agent passes `--session NAME`. The first command with a new session
claims a dedicated tab (in a shared per-profile agent window) and pins it on
disk; later commands drive that same tab, so two agents never hijack each
other. `--profile NAME` picks the connected Chrome profile. `--new-window`
forces a fresh window, `--here` shares the focused one, `--window ID` a
specific one. `--tab ID` overrides the pin for one call.

```sh
node cli.js '{"action":"claim"}' --session NAME     # pin a dedicated tab
node cli.js '{"action":"guard"}' --session NAME     # pull the tab back if it drifted
node cli.js '{"action":"release"}' --session NAME   # close the pinned tab, forget it
```

One hard limit: Chrome allows one debugger per tab, so two agents must not
drive the same tab at once — separate sessions never contend.

### Actions

```sh
# See
node cli.js '{"action":"snap"}'                      # title, url, text, numbered clickable items
node cli.js '{"action":"read"}'                      # 12000 chars of page text; {"offset":12000} continues
node cli.js '{"action":"form"}'                      # inputs/selects/radios + visible error text
node cli.js '{"action":"dialog"}'                    # open dialog text
node cli.js '{"action":"findText","text":"Total"}'   # where text sits on the page
node cli.js '{"action":"hrefs","text":"docs"}'       # links matching text/href
node cli.js '{"action":"shot"}'                      # screenshot → ~/.pilot/shots/ (or --out FILE)

# Act
node cli.js '{"action":"clickN","n":3}'              # click item 3 from the last snap
node cli.js '{"action":"clickText","text":"Save"}'   # forgiving text match ("exact":true to pin)
node cli.js '{"action":"click","sel":"button.x"}'    # CSS selector
node cli.js '{"action":"clickXY","x":100,"y":200}'   # coordinates
node cli.js '{"action":"hoverXY","x":100,"y":200}'   # move mouse there, no click (reveals hover-only UI)
node cli.js '{"action":"hover","text":"Save"}'       # resolve by {text}/{n}/{sel}, move mouse onto it, no click
node cli.js '{"action":"type","sel":"#msg","text":"hi"}'      # set a field (framework-safe events)
node cli.js '{"action":"replace","sel":"#name","text":"Ada"}' # clear then type
node cli.js '{"action":"typeKeys","sel":"#card","text":"4242"}' # real per-char keystrokes (masked fields)
node cli.js '{"action":"fill","sel":"[name=size]","value":"medium"}' # selects also match by option label
node cli.js '{"action":"fillShadow","match":"email","value":"a@b.c"}' # fields inside shadow DOM
node cli.js '{"action":"key","key":"Enter"}'         # "meta":true, "shift":true

# Tabs
node cli.js '{"action":"navigate","url":"https://x"}'  # waits for the load (15s cap)
node cli.js '{"action":"tabs"}'                        # every tab
node cli.js '{"action":"windows"}'                     # every window
node cli.js '{"action":"activeTab"}'                   # what YOU are looking at (agents avoid it)
node cli.js '{"action":"tabInfo","tabId":123}'
node cli.js '{"action":"closeTab","tabId":123}'
node cli.js '{"action":"newHarnessTab","url":"https://x"}'
node cli.js '{"action":"reload"}'                      # reload the extension itself
```

Commands sent to a profile that isn't connected are queued on the relay and
delivered the moment that profile connects.

## Screenshots

`shot` returns a small image (downscaled to the configured max width, JPEG by
default). Active-tab captures use `captureVisibleTab`; background tabs use the
DevTools Protocol, so no focus is touched. The CLI writes the file and prints
the path:

```sh
./ocr ~/.pilot/shots/12345.jpg          # plain text lines
./ocr ~/.pilot/shots/12345.jpg --json   # per-line boxes + confidence
```

## Small-model eval

`eval/drive.mjs` hands a task to any OpenRouter model and lets it drive a real
tab, one JSON action per turn, using the refined instruction block in
`eval/prompt.md`:

```sh
node eval/drive.mjs "Order a medium pizza with bacon on https://httpbin.org/forms/post ..."
```

GLM 5.3 Flash completes form-fill and search-and-extract tasks in ~13 steps.

## Vision driving

`vision.mjs` runs the same loop but with eyes: every turn it bundles the DOM
snapshot (numbered items) **with** a screenshot and sends both to a vision model
on OpenRouter, which returns the next JSON action. Use it when the DOM alone
isn't enough — hover-only menus, canvas, shadow DOM, or "is the menu actually
open yet?".

```sh
node vision.mjs "delete every OT security chat in the sidebar" --model google/gemini-2.0-flash
```

Defaults to a cheap vision model; override with `--model` (any OpenRouter
vision-capable slug). Reads `OPENROUTER_API_KEY` from `~/.dsh/.credentials.yaml`.

## Settings

Pilot options page (right-click the icon → Options):

- **Profile name** — how this Chrome profile appears on the relay
- **Relay URL** / **Harness URL** — where the relay and harness listen
- **Trusted input** — clicks/keys via the Chrome debugger (on by default)
- **Auto-connect on browser start** — on by default
- **Auto-start the relay on Connect** — on by default
- **Driven-tab group name and color** — default `Harness` / red
- **Bring the driven tab forward on every action** — off by default
- **Visual feedback** (glow + cursor) — off for clean recordings
- **Screenshot method / max width / format**

## Tests

```sh
npm test        # node:test — relay handshake, multi-profile, queuing, status
```

## Install (unpacked)

1. `git clone https://github.com/FatherMarz/pilot.git`
2. `open chrome://extensions`, turn on **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. Pin Pilot to the toolbar — it connects on its own.

## License

MIT
