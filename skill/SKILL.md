---
name: pilot
description: "Drive the user's Chrome browser from the harness via the Pilot bridge — clicks, keys, typing, form fills, tab management, and small screenshots (read locally with OCR, no vision API key needed). Use when the user asks you to do something in the browser (a web app, a form, a marketplace page), when you need to see or interact with a page, or when a task mentions Pilot or driving Chrome. Requires the Pilot relay (starts with the harness) and the Pilot extension in Chrome (auto-connects)."
---

# /pilot — Drive Chrome from the harness

Pilot is a local bridge: a Chrome extension + a relay + a CLI. You command the CLI,
the relay routes to the connected Chrome profile, the extension clicks/types/snapshots
the page. It works on **background tabs** — you do not need to steal the user's window.

Everything lives at `~/Documents/Development/custom-tools/pilot`. Run commands from there.

## The golden loop (do this, in this order)

```sh
cd ~/Documents/Development/custom-tools/pilot
node cli.js '{"action":"claim"}' --session myjob        # 1. pin a tab, ONCE
node cli.js '{"action":"navigate","url":"https://..."}' --session myjob   # waits for load
node cli.js '{"action":"snap"}' --session myjob         # 2. LOOK: numbered items
node cli.js '{"action":"clickN","n":4}' --session myjob # 3. ACT: click item 4 from the snap
node cli.js '{"action":"snap"}' --session myjob         # 4. CONFIRM it worked
```

Clicks and keys are TRUSTED input: Pilot resolves the element, then clicks it
through the Chrome debugger, so pages see `event.isTrusted === true` — same as
a human click (and same as Claude in Chrome). Pilot NEVER disturbs the user: if the target
tab sits in the window the user is working in, it stays a background tab and
gets simulated events instead (those work fine unfocused). The reply's `via`
field says which path ran (`cdp`, `synthetic-background`, `synthetic-covered`,
`synthetic-fallback`).

Look before you click. Snap, act, snap again. One action at a time.
`clickN` (click by snap item number) is the most reliable click — no selector, no
text-matching, no coordinates. When in doubt: `node cli.js '{"action":"help"}'`
prints every command with an example (works even with the relay down).

## Reading replies

Every reply is JSON with an `ok` field.
- `ok: true` → the action happened; the reply says what it hit (`clicked`, `valueNow`, ...).
- `ok: false` → read `error` and `hint`. Failures include recovery data: a failed
  click returns `visibleTexts` (what you CAN click), a failed fill returns `fields`
  (what exists), a failed select fill returns `options`. Use that data — do not retry
  the same command blind.

## Before you start (the handshake)

1. Relay: `curl -s http://127.0.0.1:8756/` → `{"server":"pilot","profiles":[...]}`.
   It starts with the harness; if it is down, run `node server.js` in the pilot dir
   (background it).
2. If `profiles` is empty the extension is not connected. It auto-connects on browser
   start, so normally it is already there. If it is genuinely absent, ask the user ONCE
   to click **Connect** in the Pilot popup. **Do not ask twice.**
3. `node cli.js --status` shows the connected profile names. Target one with
   `--profile NAME` (default is `default`).

## The commands

`node cli.js '<json>' --session NAME`. Single-quote the JSON, double-quote the keys.

| Goal | Command |
| --- | --- |
| Help (full list + examples) | `{"action":"help"}` |
| See the page | `{"action":"snap"}` — title, url, text, **numbered** clickable items |
| Click snap item N | `{"action":"clickN","n":3}` — the reliable default |
| Click by text | `{"action":"clickText","text":"Save"}` — forgiving (case, partial); `"exact":true` to pin |
| Click by CSS selector | `{"action":"click","sel":"button.submit"}` |
| Click by coordinates | `{"action":"clickXY","x":300,"y":500}` — use x/y from snap |
| Type into the visible field | `{"action":"type","text":"hello"}` — sets the field to the text |
| Type into a specific field | `{"action":"type","sel":"#message","text":"hi"}` |
| Replace field content | `{"action":"replace","sel":"#name","text":"Ada"}` |
| Real keystrokes (masked/formatted fields) | `{"action":"typeKeys","sel":"#card","text":"4242424242424242"}` — use when `type`/`fill` doesn't stick |
| Set input/select value | `{"action":"fill","sel":"[name=size]","value":"medium"}` — selects also match by option label |
| Fill a shadow-DOM field | `{"action":"fillShadow","match":"email","value":"a@b.c"}` — `match` is a substring of the field's name/placeholder/aria-label |
| Press a key | `{"action":"key","key":"Enter"}` (`"meta":true`, `"shift":true`) |
| Inspect form fields | `{"action":"form"}` — inputs, selects, radios, visible error text |
| Open dialog text | `{"action":"dialog"}` |
| Find text position | `{"action":"findText","text":"Total"}` |
| Read a long page | `{"action":"read"}` — 12000 chars of page text; `"offset":12000` continues |
| Navigate (waits for load) | `{"action":"navigate","url":"https://example.com"}` — returns `loaded:false` if >15s |
| List tabs | `{"action":"tabs"}` |
| Screenshot | `{"action":"shot"}` (to `~/.pilot/shots/`; `--out FILE` to choose) |

## Sessions — pin your own tab so nothing hijacks it

**Always drive through a session.** `claim` once, then put `--session NAME` on every
command. The pin survives across CLI invocations (`~/.pilot/session.json`).

```sh
node cli.js '{"action":"claim"}' --session NAME   # get/claim a dedicated tab
node cli.js '{"action":"guard"}' --session NAME   # tab drifted? pull it back
node cli.js '{"action":"release"}' --session NAME # close the tab and forget it
node cli.js --sessions                            # list every session's pinned tab
```

- Different `--session` per task (e.g. `chatgpt`, `checkout`) — two jobs never collide.
- `--tab ID` drives one specific tab for a single command without touching the pin.
- Same window, different tabs: separate sessions. Different windows: `claim --new-window`.
  Different Chrome profiles: `--profile work` vs `--profile personal`.
- Hard limit: one debugger per tab (Chrome's rule). Two agents must not drive the
  SAME tab at once; own sessions → no contention.

## Reading screenshots — no API key needed

```sh
node cli.js '{"action":"shot"}' --out /tmp/page.jpg --session myjob
./ocr /tmp/page.jpg          # text lines (macOS Vision, local)
./ocr /tmp/page.jpg --json   # boxes + confidence
```

Prefer OCR for reading screenshot text; use a vision model only for visual layout.
For plain text content, `snap` (`.text`) is cheaper than a screenshot.

## Troubleshooting

- `timeout — is the relay running?` → start it: `node server.js` (in the pilot dir).
- `"queued": true` → that profile is not connected. Check `--status`; if genuinely
  disconnected, ask the user once to click Connect in the popup.
- `unknown action` → the extension is running old code. Send `{"action":"reload"}`,
  wait 3s; it auto-reconnects with the new code.
- Screenshot empty/black → the tab may be discarded; `navigate` first to wake it.
- Clicks land but nothing happens → the page may use a dialog or a shadow DOM;
  try `dialog`, `form`, or `fillShadow`.

## Handing Pilot to a small model

`eval/prompt.md` is a battle-tested per-turn instruction block for small models
(one JSON action per turn, no prose). `eval/drive.mjs` runs a task end to end
with any OpenRouter model:

```sh
node eval/drive.mjs "Order a medium pizza with bacon on https://httpbin.org/forms/post ..."
```

GLM 5.3 Flash completes form-fill and search-and-extract tasks in ~13 steps
with that prompt. Key details that made it work: numbered snap items, checked
state on toggles, `checkedNow` in click results, and recovery hints on every
failure.
