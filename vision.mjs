#!/usr/bin/env node
// Vision-in-the-loop driving: screenshot -> vision model -> one JSON action,
// repeat. Each turn bundles the DOM snapshot (snap text + numbered clickable
// items) WITH the screenshot, so the model gets both precise targeting and
// real sight — the DOM when it is trustworthy, vision when it lies (hover-only
// controls, canvas, shadow DOM, "is the menu actually open?").
//
//   node vision.mjs "delete every OT security chat in the sidebar" [--model id] [--steps 40]
//
// Defaults to a cheap vision model. Override with --model (any OpenRouter
// vision-capable slug, e.g. google/gemini-2.0-flash, anthropic/claude-3.5-sonnet).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION = process.env.DSH_SESSION_ID || "vision";
const PROFILE = "modul4r";

const argv = process.argv.slice(2);
const task = argv.filter((a) => !a.startsWith("--"))[0];
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MODEL = opt("model", "openai/gpt-4o-mini");
const MAX_STEPS = Number(opt("steps", "40")) || 40;

if (!task) {
  console.error('usage: node vision.mjs "<task>" [--model id] [--steps 40]');
  process.exit(1);
}

const creds = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const apiKey = (creds.match(/OPENROUTER_API_KEY:\s*["']?([^"'\s]+)/) || [])[1];
if (!apiKey) {
  console.error("no OPENROUTER_API_KEY in ~/.dsh/.credentials.yaml");
  process.exit(1);
}

const SYSTEM = `You drive a real Chrome browser to complete a task. Each turn reply with ONE JSON action object and nothing else — no prose, no markdown fences. End with exactly: DONE: <one short sentence>.

Actions (send the JSON):
{"action":"snap"}                      see the page: title, url, text, numbered clickable items
{"action":"shot"}                      screenshot (you already receive one each turn)
{"action":"clickN","n":3}              click item 3 from the last snap
{"action":"clickText","text":"Save"}   click by visible text; add "exact":true for exact
{"action":"click","sel":"button.go"}   click by CSS selector
{"action":"clickXY","x":300,"y":500}   click viewport coordinates
{"action":"hoverXY","x":300,"y":500}   MOVE the mouse there, do not click — reveals hover-only UI
{"action":"hover","text":"Save"}       resolve by {text}/{n}/{sel}, move mouse onto it, no click
{"action":"type","sel":"input[name=q]","text":"hi"}   type into a field
{"action":"replace","sel":"#x","text":"y"}           clear a field then type
{"action":"fill","sel":"select[s]","value":"CA"}     set an input/select value
{"action":"key","key":"Enter"}         press a key (Enter, Tab, Escape, ArrowDown, End, ...)
{"action":"form"}                      list every form field and current value
{"action":"read"}                      full page text (12000 chars); {"offset":12000} for more
{"action":"dialog"}                    text of the open dialog, null if none
{"action":"navigate","url":"https://..."}   open a page (waits for load)

Rules:
1. Reply with ONE JSON action or the DONE line. Never explain.
2. The screenshot shows the REAL current state — trust it over the DOM text. The DOM items let you click precisely; use hoverXY/hover or clickXY when the DOM does not name the target (hover-only "...", canvas, images).
3. Hover before clicking hover-revealed controls: hoverXY at the row, then clickN/clickXY the revealed button at its new position.
4. After any click or navigation, snap or screenshot to confirm what changed. Do not reuse stale coordinates.
5. On ok:false read "error" and "hint" and try the suggested recovery. Never repeat the exact same failing action.
6. When the task is done, reply "DONE: <result>".`;

function pilot(cmd) {
  try {
    return execFileSync(
      "node",
      [join(ROOT, "cli.js"), JSON.stringify(cmd), "--session", SESSION, "--profile", PROFILE],
      { encoding: "utf8", timeout: 70000 },
    ).trim();
  } catch (e) {
    return ((e.stdout || "") + (e.stderr || "")).trim() || `driver error: ${e.message}`;
  }
}

function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function shotToDataUrl() {
  const out = pilot({ action: "shot", maxWidth: 900, quality: 0.7 });
  let file;
  try { file = JSON.parse(out).file; } catch { return null; }
  if (!file || !existsSync(file)) return null;
  const b64 = readFileSync(file).toString("base64");
  const ext = file.endsWith(".png") ? "png" : "jpeg";
  return `data:image/${ext};base64,${b64}`;
}

function snapSummary() {
  const raw = pilot({ action: "snap" });
  let s;
  try { s = JSON.parse(raw).value; } catch { return raw.slice(0, 4000); }
  const items = (s.items || [])
    .map((i) => `${i.n} ${i.text || i.icon} @${i.x},${i.y}`)
    .join("\n");
  return `TITLE: ${s.title || ""}\nURL: ${s.url || ""}\n\nCLICKABLE:\n${items}\n\nTEXT:\n${(s.text || "").slice(0, 3000)}`;
}

async function ask(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, temperature: 0.1, messages }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body.choices?.[0]?.message?.content ?? "";
}

pilot({ action: "release" });
const claim = pilot({ action: "claim" });

const messages = [{ role: "system", content: SYSTEM }];
let outcome = "MAX_STEPS";

for (let step = 1; step <= MAX_STEPS; step++) {
  const snap = snapSummary();
  const img = shotToDataUrl();
  const content = [
    { type: "text", text: `TASK: ${task}\n\nPAGE STATE:\n${snap}` },
  ];
  if (img) content.push({ type: "image_url", image_url: { url: img } });
  messages.push({ role: "user", content });

  let reply;
  try { reply = await ask(messages); } catch (e) {
    console.error(`model error: ${e.message}`);
    break;
  }
  process.stderr.write(`step ${step}: ${reply.slice(0, 120).replace(/\n/g, " ")}\n`);

  if (/^\s*DONE:/m.test(reply)) {
    outcome = reply.match(/DONE:.*$/m)[0];
    break;
  }

  const cmd = extractJson(reply);
  if (!cmd) {
    messages.push({ role: "user", content: "Reply with ONE JSON action object only, or \"DONE: <result>\"." });
    continue;
  }

  let result = pilot(JSON.parse(cmd));
  if (result.length > 2600) result = result.slice(0, 2600) + "\n...[truncated]";
  messages.push({ role: "user", content: `RESULT:\n${result}` });
}

pilot({ action: "release" });
console.log(`\noutcome: ${outcome}`);
