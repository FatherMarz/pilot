# Pilot

A local bridge that lets an agent harness drive a Chrome profile: clicks, keys,
typing, form fills, tab management and small screenshots, without taking over
your window.

Three pieces:

| Piece | What it is |
| --- | --- |
| `extension/` | MV3 Chrome extension. Auto-connects to the relay on browser start; the popup shows the state and can disconnect. |
| `server.js` | The relay. One relay serves every Chrome profile on the machine. `node server.js`. |
| `cli.js` | Harness-side client. `node cli.js '{"action":"snap"}'`. Run `node cli.js '{"action":"help"}'` for the full cheat sheet. |

`ocr.swift` is an on-device macOS Vision OCR tool (`npm run build:ocr`) that reads
screenshot text without an API key.

## Trusted input

Clicks, keys and typing go through the Chrome debugger (`Input.dispatch*`,
`Input.insertText`), so pages receive real user input: `event.isTrusted === true`,
default actions run, and React/Angular forms see the change. Element targeting
stays semantic: `ref`/`clickN`/`clickText` resolve the element, scroll it into
view, and the debugger clicks its center.

Pilot never activates, focuses or switches to a tab. It drives a **background
tab**, even one in the window you are working in. The debugger attaches once per
tab and stays attached until the tab closes (no infobar flashing between
actions), with focus emulation on so the background page behaves as if focused.
Each action checks that the page actually received the input; only if it did
not does Pilot fall back to simulated events.

Every reply's `via` field says which path ran: `cdp`, `synthetic-covered`
(element under an overlay), `synthetic-select` (`<select>` fill),
`synthetic-fallback` (debugger unavailable or input did not land), or
`synthetic` (trusted input turned off).

Hover-revealed controls (a "..." that only appears on mouseenter) are handled
automatically: a trusted click first glides the mouse onto the element, lets the
hover state settle, re-measures the element's *new* position, then clicks — so it
never clicks the stale pre-hover spot. For hovering *without* clicking, use
`hover` / `hoverXY`.

## Install

```sh
git clone https://github.com/FatherMarz/pilot.git
cd pilot && npm install
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and
select the `extension/` folder. Pin Pilot to the toolbar.

## Quick start

```sh
# Run the relay (a harness normally starts it for you)
node server.js

# Drive it
node cli.js --status
node cli.js '{"action":"claim"}' --session myjob
node cli.js '{"action":"navigate","url":"https://example.com"}' --session myjob
node cli.js '{"action":"snap"}' --session myjob
node cli.js '{"action":"click","ref":"p1r3"}' --session myjob
node cli.js '{"action":"release"}' --session myjob
```

The extension connects on browser start (turn **Auto-connect** off in Options
for a strictly manual popup handshake). After editing extension code, send
`{"action":"reload"}` — Chrome does not reload unpacked extension code on
browser restart.

## The loop a driving model follows

`snap` prints one short line per clickable item, ref first
(`p1r3 button "Save"`), on-screen items first, under 4 KB for a typical page;
`"full":true` returns the JSON. Act on a ref, then snap again. A ref carries
its page number (`p1`), so a ref from a page that has since navigated is
refused ("page changed since that snap — snap again") instead of hitting a
different element. Every reply has one `ok` at the top; failures carry
`error`, `hint` and recovery data (`visibleTexts`, `fields`, `options`).
Input actions report `navigated:true` when the page changed,
`opened:{tabId,url}` when a new tab opened (always in the background), and
`dialog:{...}` when an alert/confirm/prompt was answered. Iframes are read
too: their items carry `[frame N]` and their refs work like any other.

## CLI reference

```sh
node cli.js --status         # who is connected
node cli.js --sessions       # every agent's tab pin (~/.pilot/session.json)
node cli.js '{"action":"help"}'   # full command list with examples
```

### Sessions — one tab per agent

Every agent passes `--session NAME` and runs `claim` once: it pins a
dedicated tab (a background tab in the window you are using) on disk; later
commands drive that same tab, so two agents never hijack each other. A
command on a session that was never claimed fails with "run claim first"
(a typo never opens a stray tab). `--profile NAME` picks the connected Chrome profile.
`--new-window` uses a separate per-profile agent window instead, `--window ID`
a specific one. `--tab ID` overrides the pin for one call.

Claim is frugal by default: it reuses your pinned tab, then **adopts the tab
of an idle session** (same profile, idle 30+ min, blank tabs first) instead of
opening another one, and only creates a fresh tab as a last resort.
`--no-reuse` forces a new tab; `--stale-minutes N` changes the idle threshold.

When idle sessions pile up, claim and `--sessions` return a `hint` naming the
cleanup command. `--sessions` lists every session with its tab state, URL, and
idle time, so an agent can see the whole board before acting.

```sh
node cli.js '{"action":"claim"}' --session NAME     # pin a dedicated tab (reuses/adopts first)
node cli.js '{"action":"guard"}' --session NAME     # pull the tab back if it drifted
node cli.js '{"action":"release"}' --session NAME   # close the tab and the tabs it opened
node cli.js --sessions --profile NAME               # every session: alive, url, idle
node cli.js gc                                      # release STALE sessions only, sweep orphan Pilot tabs
node cli.js '{"action":"cleanup"}'                  # dry run: what a sweep would close ("apply":true does it)
```

Cleanup is built in: the extension remembers each session's tab and the tabs
it opened. `release` closes them; sessions idle longer than the Options limit
(default 30 min) are released by the extension itself; orphan Pilot tabs
(blank, discarded, or untouched past the limit) are swept on start and on
every claim. A tab the user is looking at is never closed, only taken out of
the Pilot group; a tab the user moved out of the group is left alone.

One hard limit: Chrome allows one debugger per tab, so two agents must not
drive the same tab at once — separate sessions never contend.

### Actions

```sh
# See
node cli.js '{"action":"snap"}'                      # title, url, text, numbered clickable items
node cli.js '{"action":"read"}'                      # 12000 chars of page text; {"offset":12000} continues
node cli.js '{"action":"form"}'                      # every field + field-bound errors + missing required
node cli.js '{"action":"dialog"}'                    # open dialog text
node cli.js '{"action":"findText","text":"Total"}'   # where text sits on the page
node cli.js '{"action":"hrefs","text":"docs"}'       # links matching text/href
node cli.js '{"action":"shot"}'                      # screenshot → ~/.pilot/shots/ (or --out FILE)

# Act
node cli.js '{"action":"click","ref":"p1r3"}'        # click by ref from the last snap
node cli.js '{"action":"clickN","n":3}'              # click item 3 of the last snap
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
node cli.js '{"action":"upload","ref":"p1r6","path":"/abs/file.pdf"}' # file inputs
node cli.js '{"action":"drag","from":"p1r2","to":"p1r9"}'  # drag and drop
node cli.js '{"action":"scroll","dy":800}'           # or "to":"top"|"bottom", or "ref" to bring into view
node cli.js '{"action":"wait","text":"Done"}'        # or "sel", "gone", "ms"; "timeout" (default 10s)
node cli.js '{"action":"back"}'                      # and forward
node cli.js '{"action":"dialogPolicy","accept":false,"once":true}' # how to answer the next JS dialog

# Inspect
node cli.js '{"action":"text"}'                      # main content text, no nav/header/footer
node cli.js '{"action":"eval","js":"document.title"}' # JSON result, main frame, with a timeout
node cli.js '{"action":"console","level":"error"}'   # recent console messages
node cli.js '{"action":"network","failed":true}'     # recent requests

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

Commands are never queued: a page action for a profile that isn't connected
fails at once ("not connected — ask the user to click Connect"), so nothing
replays late after the CLI reported a failure. Read-only metadata (status,
tabs) waits up to 4 seconds for a reconnecting extension, then fails.

## Screenshots

`shot` returns a small image (downscaled to the configured max width, JPEG by
default). Active-tab captures use `captureVisibleTab`; background tabs use the
DevTools Protocol, so no focus is touched. The CLI writes the file and prints
the path:

```sh
./ocr ~/.pilot/shots/12345.jpg          # plain text lines
./ocr ~/.pilot/shots/12345.jpg --json   # per-line boxes + confidence (exit 3 = no text found)
```

## Small-model eval

`eval/drive.mjs` hands a task to any OpenRouter model and lets it drive a real
tab, one JSON action per turn, using the refined instruction block in
`eval/prompt.md`:

```sh
node eval/drive.mjs "Order a medium pizza with bacon on https://httpbin.org/forms/post ..."
```

## Vision driving

`vision.mjs` runs the same loop but with eyes: every turn it bundles the DOM
snapshot (numbered items) **with** a screenshot and sends both to a vision model
on OpenRouter, which returns the next JSON action. Use it when the DOM alone
isn't enough — hover-only menus, canvas, shadow DOM, or "is the menu actually
open yet?".

```sh
node vision.mjs "close every open chat in the sidebar" --model google/gemini-2.0-flash
```

Override the default model with `--model` (any OpenRouter vision model). Reads `OPENROUTER_API_KEY` from the environment.

## Settings

Pilot options page (right-click the icon → Options):

- **Profile name** — how this Chrome profile appears on the relay
- **Relay URL** / **Harness URL** — where the relay and harness listen
- **Trusted input** — clicks/keys via the Chrome debugger (on by default)
- **Auto-connect on browser start** — on by default
- **Auto-start the relay on Connect** — on by default
- **Driven-tab group name and color** — default `Pilot` / yellow
- **Bring the driven tab forward on every action** — off by default
- **Visual feedback** (glow + cursor) — off for clean recordings
- **Screenshot method / max width / format**

## Tests

```sh
npm test        # node:test — relay handshake, multi-profile, queuing, status
```

## License

MIT. Built by Marcello Delcaro, AI-assisted.
