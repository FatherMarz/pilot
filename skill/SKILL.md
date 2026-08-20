---
name: pilot
description: "Drive Marcello's Chrome browser from the harness via the Pilot bridge — clicks, keys, typing, form fills, tab management, and small screenshots (read locally with OCR, no vision API key needed). Use when Marcello asks you to do something in the browser (a web app, a form, a marketplace page), when you need to see or interact with a page, or when a task mentions Pilot, chrome-bridge, or driving Chrome. Requires the Pilot relay running (node server.js), the Pilot extension loaded in Chrome, and Connect clicked in the popup (that handshake is deliberate)."
---

# /pilot — Drive Chrome from the harness

Pilot is a local bridge: a Chrome extension + a relay + a CLI. You command the CLI,
the relay routes to the connected Chrome profile, the extension clicks/types/snapshots
the page. It works on **background tabs** — you do not need to steal Marcello's window.

## Before you start (the handshake)

1. Relay must be running: `node server.js` (in `~/Documents/Development/custom-tools/chrome-bridge`).
   Check with `curl -s http://127.0.0.1:8756/` — it returns `{"server":"pilot","profiles":[...]}`.
2. The extension must be connected. Ask Marcello to click **Connect** in the Pilot popup
   if `profiles` is empty. **Do not ask twice.** If he already connected, just proceed.
3. Use `node cli.js --status` to see which profile(s) are connected and their names.
   Target the right one with `--profile NAME` (default profile is `default`).

## The commands

All commands go through the CLI. The CLI lives at:
`~/Documents/Development/custom-tools/chrome-bridge/cli.js` — run it with `node cli.js '<json>'`.
Add `--profile NAME` when the profile isn't the default. Add `--out FILE` to a `shot`
to choose where the image lands.

### One tab per agent — always pass `--session`

Every command takes `--session "$DSH_SESSION_ID"`. That is your unique agent id.
The first command with a new session claims a dedicated background tab and pins
it on disk; every later command drives that same tab. Your tab is yours — another
agent with a different session id gets its own tab and can never hijack yours.
Two agents in the same window get separate tabs; different windows and different
Chrome profiles also work:

```sh
node cli.js '{"action":"snap"}' --session "$DSH_SESSION_ID"                  # same window
node cli.js '{"action":"claim"}' --session "$DSH_SESSION_ID" --new-window    # own window
node cli.js '{"action":"claim"}' --session "$DSH_SESSION_ID" --window 123    # given window
node cli.js '{"action":"snap"}' --session "$DSH_SESSION_ID" --profile work   # other profile
node cli.js '{"action":"release"}' --session "$DSH_SESSION_ID"   # close your tab when done
node cli.js '{"action":"guard"}' --session "$DSH_SESSION_ID"     # pull the tab back if it drifted
node cli.js --sessions                                           # see every agent's pin
```

Never omit `--session`: without it every agent shares the "default" pin and you
can collide with another driver.

| Goal | Command |
| --- | --- |
| What's on the page | `node cli.js '{"action":"snap"}'` — title, url, page text, clickable items with coordinates |
| Claim your dedicated tab | `node cli.js '{"action":"claim"}'` (auto-claimed on your first command) |
| Close your tab when done | `node cli.js '{"action":"release"}'` |
| Click by text | `node cli.js '{"action":"clickText","text":"Save"}'` (add `"exact":true` for exact match) |
| Click by CSS selector | `node cli.js '{"action":"click","sel":"button.submit"}'` |
| Click by coordinates | `node cli.js '{"action":"clickXY","x":300,"y":500}'` |
| Type into focused field | `node cli.js '{"action":"type","text":"hello"}'` |
| Type into a field | `node cli.js '{"action":"type","sel":"#message","text":"hi"}'` |
| Replace field content | `node cli.js '{"action":"replace","sel":"#name","text":"Ada"}'` |
| Set input/select value | `node cli.js '{"action":"fill","sel":"#country","value":"CA"}'` |
| Press a key | `node cli.js '{"action":"key","key":"Enter"}'` (meta: `"meta":true`, shift: `"shift":true`) |
| Open dialog text | `node cli.js '{"action":"dialog"}'` |
| Inspect form fields | `node cli.js '{"action":"form"}'` — inputs, selects, radios, error text |
| Find text position | `node cli.js '{"action":"findText","text":"Save"}'` |
| Navigate | `node cli.js '{"action":"navigate","url":"https://example.com"}'` |
| List tabs | `node cli.js '{"action":"tabs"}'` |
| Small screenshot | `node cli.js '{"action":"shot"}'` (saved to `~/.pilot/shots/`, path printed) |

## Reading screenshots — no API key needed

Pilot ships with a local OCR binary built on macOS Vision:

```sh
cd ~/Documents/Development/custom-tools/chrome-bridge
node cli.js '{"action":"shot"}' --out /tmp/page.jpg   # writes the image
./ocr /tmp/page.jpg                                   # text lines
./ocr /tmp/page.jpg --json                            # boxes + confidence
```

This works even when the OpenRouter/vision key is broken. Prefer OCR for reading
screenshot text; only use a vision model when you need visual layout (colors, images).

## Workflow guidance

- **Look before you click.** `snap` first, then act on what you saw.
- **One action at a time.** Click, then `snap`/`dialog` to confirm the result.
- **Background tabs are fine.** Pilot doesn't steal focus by default. If Marcello
  explicitly wants to watch, mention that he can enable "Bring the driven tab
  forward" in the Pilot options.
- **Queued commands.** If a profile isn't connected, the relay queues the command
  and the CLI exits with `"queued": true`. That means: the profile isn't connected —
  ask Marcello to click Connect (once), or pick the right profile.
- **Form fills:** use `form` to see the fields, `fill`/`type` to set them, and
  `dialog` to read validation errors.

## Troubleshooting

- `timeout — is the relay running?` → start it: `node server.js`.
- `"error":"queued"` → that profile isn't connected. Check `--status`, pick the right profile.
- Screenshot empty/black → the tab may be discarded; `navigate` or `tabs` first to wake it.
- Bad JSON → single-quote the command in the shell and double-quote the keys.
