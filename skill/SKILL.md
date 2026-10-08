---
name: pilot
description: "Drive the user's Chrome browser from the harness via the Pilot bridge — clicks, keys, typing, form fills, uploads, tab management, and small screenshots (read locally with OCR, no vision API key needed). Use when the user asks you to do something in the browser (a web app, a form, a marketplace page), when you need to see or interact with a page, or when a task mentions Pilot or driving Chrome. Requires the Pilot relay (starts with the harness) and the Pilot extension in Chrome (auto-connects)."
---

# /pilot — Drive Chrome from the harness

Pilot drives ONE background tab in the user's Chrome. It never brings that tab
to the front and never changes the tab the user is looking at.

Pilot lives at `~/Development/custom-tools/pilot` (or wherever you cloned it).
Run every command from there:

```sh
cd ~/Development/custom-tools/pilot
```

## The golden loop

```sh
node cli.js '{"action":"claim"}' --session job                              # 1. get your tab (once)
node cli.js '{"action":"navigate","url":"https://example.com"}' --session job  # 2. open the page
node cli.js '{"action":"snap"}' --session job                               # 3. look
node cli.js '{"action":"click","ref":"p1r3"}' --session job                 # 4. act on ONE ref
node cli.js '{"action":"snap"}' --session job                               # 5. look again
node cli.js '{"action":"release"}' --session job                            # 6. ALWAYS release when done
```

`snap` prints one line per item. The first word is the ref:

```
ok:true page p1 "Login" https://example.com/login
items (3), on screen first; act with the ref, e.g. {"action":"click","ref":"p1r1"}:
p1r1 textbox "Username" (empty)
p1r2 textbox "Password" (empty)
p1r3 button "Log in"
```

## Rules

- Put `--session NAME` on every command. Use the same NAME the whole task.
- Run `claim` first. Without it every command fails with "run claim first".
- Single-quote the JSON. Double-quote the keys.
- One action per command. Then check the reply.
- Check `ok` in every reply. `ok:false` means it did NOT work.
- On `ok:false`, read `error` and `hint` and do what the hint says. Do not repeat the same command.
- Use refs from the LAST snap only (`p1r3`). The `p1` part is the page.
- After a navigation, snap again. Old refs fail with "page changed since that snap — snap again".
- A reply with `navigated:true` means the page changed: snap again.
- To type into a field: `{"action":"type","ref":"p1r1","text":"hello"}`.
- To choose in a dropdown or set a date/time/number: `{"action":"fill","ref":"p1r5","value":"2026-10-08"}`.
- Dates are `YYYY-MM-DD`, times `HH:MM`. A bad value fails and the field keeps its old value.
- To press Enter in the focused field: `{"action":"key","key":"Enter"}`.
- If an item is not in the snap, scroll: `{"action":"scroll","dy":800}`, then snap.
- If the page is still loading, wait: `{"action":"wait","text":"Welcome"}`.
- New tabs open in the background. The reply shows `opened:{"tabId":123,"url":"..."}`. Drive it with `--tab 123`.
- Alerts, confirms and prompts are answered for you (accept), with or without the debugger. The reply shows `dialog:{...}`.
- To dismiss the next dialog instead: `{"action":"dialogPolicy","accept":false,"once":true}`.
- Items marked `[frame 2]` are inside an iframe. Use their refs like any other.
- For long text use `{"action":"text"}` (main content) or `{"action":"read"}` (everything).
- Unknown action? Run `{"action":"help"}`. Do NOT run reload.
- Never log in to real accounts, buy, post or submit real data unless the user asked you to.
- When the task is done, run `release`. It closes your tab and the tabs it opened.

## Every action

`node cli.js '{"action":"help"}'` prints this list with one example each
(it works even when the relay is down).

| Goal | Command |
| --- | --- |
| Get your tab | `{"action":"claim"}` |
| Open a URL (waits for load) | `{"action":"navigate","url":"https://example.com"}` |
| See the page | `{"action":"snap"}` — `"filter":"interactive"` items only, `"full":true` JSON |
| Click | `{"action":"click","ref":"p1r3"}` |
| Click by text | `{"action":"clickText","text":"Sign in"}` |
| Type into a field | `{"action":"type","ref":"p1r4","text":"hello"}` — `"text":""` needs `"clear":true` |
| Real keystrokes (masked fields) | `{"action":"typeKeys","ref":"p1r4","text":"4242"}` |
| Set a select, date, time, number, color | `{"action":"fill","ref":"p1r5","value":"Medium"}` |
| Upload a file | `{"action":"upload","ref":"p1r6","path":"/abs/path/file.pdf"}` |
| Drag and drop | `{"action":"drag","from":"p1r2","to":"p1r9"}` |
| Press a key | `{"action":"key","key":"Enter"}` — `"meta":true` for Cmd+A/C/V/Z |
| Hover | `{"action":"hover","ref":"p1r3"}` |
| Scroll | `{"action":"scroll","dy":800}` / `"to":"bottom"` / `"ref":"p1r40"` |
| Wait | `{"action":"wait","text":"Done"}` / `"sel":"#result"` / `"gone":"Loading"` / `"ms":1000` |
| Back / forward | `{"action":"back"}` / `{"action":"forward"}` |
| Main article text | `{"action":"text"}` |
| All page text | `{"action":"read"}` — `"offset":12000` for more |
| Find text (with refs) | `{"action":"findText","text":"Total"}` |
| Form fields, errors, missing | `{"action":"form"}` |
| On-page dialog + last alert | `{"action":"dialog"}` |
| Dialog answers | `{"action":"dialogPolicy","accept":true,"promptText":"yes"}` |
| Run JavaScript | `{"action":"eval","js":"document.title"}` |
| Console errors | `{"action":"console","level":"error"}` |
| Network requests | `{"action":"network","failed":true}` |
| Screenshot | `{"action":"shot"}` then `./ocr FILE` (exit 3 = no text) |
| User's active tab | `{"action":"activeTab"}` |
| Close your tab(s) | `{"action":"release"}` |
| Stale Pilot tabs | `{"action":"cleanup"}` (dry run), `"apply":true` closes them |

## Replies

- `ok:true` — it worked. `value` has the data (`clicked`, `valueNow`, ...).
- `ok:false` — it did not. `error` says why, `hint` says what to do.
- `via` says how input went in: `cdp` (real input, normal), `native-setter`
  (date/number fields), `synthetic-*` (fallback; `cdpNote` explains why, for
  example DevTools holds the debugger). Pilot removes other extensions' frames
  (a password manager's menu) from its own tab, so they do not block real input.
- Drag replies say `via:"cdp-html5-drag"` (real drag), `cdp-mouse` (mouse-driven
  list) or `synthetic-dragevent` (fallback).
- `navigated:true` — the page changed. Snap again.
- `opened:{tabId,url}` — a new background tab. `--tab ID` drives it.
- `dialog:{type,message,accepted}` — an alert/confirm/prompt was answered
  (`via:"page-shim"` when the debugger was unavailable).

## Before you start

1. Relay: `curl -s http://127.0.0.1:8756/` shows `{"server":"pilot","profiles":[...]}`.
   If it is down: `node server.js &` in the pilot folder.
2. Empty `profiles` = the extension is not connected. It auto-connects. If it
   stays empty, ask the user ONCE to click **Connect** in the Pilot popup.
3. Commands are never queued. A command for a profile that is not connected
   fails at once with "not connected"; nothing runs later by surprise.

## Sessions and cleanup

- One `--session` per task. Two tasks never share a tab.
- `node cli.js --sessions` lists every session, its tab and idle time.
- `release` closes your tab and every tab it opened. A tab the user is
  looking at is never closed, only taken out of the yellow Pilot group.
- Sessions idle for 30 minutes (Options) are released by the extension.
- `node cli.js gc` releases only stale sessions, never live ones.
- `--new-window` on claim uses a separate unfocused agent window.
- `--profile NAME` targets another connected Chrome profile.

## Troubleshooting

- `cannot reach the Pilot relay` → start it: `node server.js &`.
- `not connected` → see "Before you start" step 2.
- `no reply from Chrome within ...` → the page is stuck; run `{"action":"status"}`, then snap.
- `page changed since that snap` → snap again and use the new refs.
- `no tab for session X — run claim first` → run claim (check the name for typos).
- `the page did not answer within 8s` → the page is busy or loading; `wait`, then snap.
- After updating Pilot's code only: `{"action":"reload"}`, wait 4 seconds.

## Handing Pilot to a small model

`eval/prompt.md` is the per-turn instruction block for small models (one JSON
action per turn). `eval/drive.mjs` runs a task end to end with any OpenRouter
model:

```sh
node eval/drive.mjs "Order a medium pizza with bacon on https://httpbin.org/forms/post ..."
```
