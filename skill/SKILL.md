---
name: pilot
description: "Drive the user's Chrome browser from the harness via the Pilot bridge — clicks, keys, typing, form fills, tab management, and small screenshots (read locally with OCR, no vision API key needed). Use when the user asks you to do something in the browser (a web app, a form, a marketplace page), when you need to see or interact with a page, or when a task mentions Pilot or driving Chrome. Requires the Pilot relay (starts with the harness) and the Pilot extension in Chrome (auto-connects)."
---

# /pilot — Drive Chrome from the harness

Pilot is a local bridge: a Chrome extension + a relay + a CLI. You command the CLI,
the relay routes to the connected Chrome profile, the extension clicks/types/snapshots
the page. It works on **background tabs** — you do not need to steal the user's window.

Run every command from the directory where you cloned Pilot.

## The golden loop (do this, in this order)

```sh
cd pilot
node cli.js '{"action":"claim"}' --session myjob        # 1. pin a tab, ONCE
node cli.js '{"action":"navigate","url":"https://..."}' --session myjob   # waits for load
node cli.js '{"action":"snap"}' --session myjob         # 2. LOOK: numbered items
node cli.js '{"action":"clickN","n":4}' --session myjob # 3. ACT: click item 4 (or {"action":"click","ref":"r5"})
node cli.js '{"action":"snap"}' --session myjob         # 4. CONFIRM it worked
```

Clicks, keys and typing are TRUSTED input (`event.isTrusted === true`), sent
through the Chrome debugger, so React/Angular forms register them. Pilot NEVER
activates, focuses or switches to a tab: it drives a background tab, even one in
the window the user is working in. The debugger attaches once per tab and stays
attached until release (Chrome shows a "started debugging" bar while it is).
Each action checks the page really got the input; only if not does it fall back
to simulated events. The reply's `via` says which path ran: `cdp` (normal),
`synthetic-covered` (element under an overlay), `synthetic-select` (`<select>`
fill), `synthetic-fallback` (debugger busy or input did not land).

Look before you click. Snap, act, snap again. One action at a time.
Every snap item has a stable `ref` (`"r12"`) that keeps pointing at the same
element after the page changes; `{"action":"click","ref":"r12"}` is the most
reliable target (also on `type`, `fill`, `hover`). `clickN` still works within
one unchanged page. When in doubt: `node cli.js '{"action":"help"}'`
prints every command with an example (works even with the relay down).

Claim is frugal by default: it reuses your tab, then adopts an idle session's
tab (same profile, idle 30+ min) instead of opening another one. `--no-reuse`
forces a fresh tab. Check the board with `node cli.js --sessions` (shows every
session's tab, URL, and idle time). If a reply carries a `hint` suggesting
`node cli.js gc --keep <your-session>`, several sessions are stale — run it.
When done, `{"action":"release"}` closes your tab and keeps the group tidy.

## Reading replies

Every reply is JSON with an `ok` field.
- `ok: true` → the action happened; the reply says what it hit (`clicked`, `valueNow`, ...).
- `ok: false` → read `error` and `hint`. Failures include recovery data: a failed
  click returns `visibleTexts` (what you CAN click), a missed type/fill target returns
  `fields` (with refs), a failed select fill returns `options`. `type`/`fill` return
  `ok:false` when the value did not stick, and `navigate` when the URL did not change. Use that data — do not retry
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
| See the page | `{"action":"snap"}` — title, url, text (incl. field values), items with `n`, `ref`, `role`, `name`, `value`, `checked`, `required`, `disabled` |
| Click by ref (stable) | `{"action":"click","ref":"r12"}` — the reliable default |
| Click snap item N | `{"action":"clickN","n":3}` — same page only |
| Click by text | `{"action":"clickText","text":"Save"}` — forgiving (case, partial); `"exact":true` to pin |
| Click by CSS selector | `{"action":"click","sel":"button.submit"}` |
| Click by coordinates | `{"action":"clickXY","x":300,"y":500}` — use x/y from snap |
| Hover | `{"action":"hover","ref":"r12"}` (or `text`/`n`/`sel`); `hoverXY` for coordinates |
| Type into a field | `{"action":"type","ref":"r3","text":"hi"}` — sets the field to the text (also `sel`) |
| Type into the focused field | `{"action":"type","text":"hello"}` — focused field, or the only field; else `ok:false` + `fields` |
| Replace field content | `{"action":"replace","ref":"r3","text":"Ada"}` (same as type) |
| Real keystrokes (masked/formatted fields) | `{"action":"typeKeys","ref":"r4","text":"4242424242424242"}` — use when `type` doesn't stick |
| Set input/select value | `{"action":"fill","ref":"r5","value":"medium"}` — selects also match by option label |
| Fill a shadow-DOM field | `{"action":"fillShadow","match":"email","value":"a@b.c"}` — `match` is a substring of the field's name/placeholder/label |
| Press a key | `{"action":"key","key":"Enter"}` — any character or key name; `"meta":true` for Cmd+A/C/X/V/Z (`"shift":true` + z = redo) |
| Inspect form fields | `{"action":"form"}` — fields of the open dialog (or page): ref, name, role, value, required, disabled, options, plus errors |
| Open dialog text | `{"action":"dialog"}` — the top visible dialog |
| Find text position | `{"action":"findText","text":"Total"}` — also matches field values |
| Read a long page | `{"action":"read"}` — 12000 chars of page text; `"offset":12000` continues |
| Navigate (waits for load) | `{"action":"navigate","url":"https://example.com"}` — absolute URL; `loaded:false` if >15s, `ok:false` if the URL did not change |
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
- Same window, different tabs: separate sessions. Own agent window: `claim --new-window`.
  Different Chrome profiles: `--profile work` vs `--profile personal`.
- Hard limit: one debugger per tab (Chrome's rule). Two agents must not drive the
  SAME tab at once; own sessions → no contention.
- Every `claim` drops pins whose tab is gone and auto-releases sessions idle >24h.
- Driven tabs sit in a yellow "Pilot" tab group. Default claim puts the tab in the
  window Marcello is using, as a background tab; `--new-window` uses one unfocused
  agent window per profile instead. Either way Pilot never brings it forward.

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
