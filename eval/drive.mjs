#!/usr/bin/env node
// Small-model driving eval: hand a task to a cheap model and let it drive a
// real Chrome tab through the Pilot CLI, one JSON action per turn.
//
//   node eval/drive.mjs "Order a medium pizza ..." [--model z-ai/glm-5.3-flash]
//
// The driver pre-claims a session tab, appends --session/--profile to every
// command, truncates results, and logs the full transcript to /tmp.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION = "smoltest";
const PROFILE = "modul4r";
const MAX_STEPS = 20;
const LOG = `/tmp/smol-run-${Date.now()}.log`;

const args = process.argv.slice(2);
const task = args.filter((a) => !a.startsWith("--"))[0];
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "z-ai/glm-5.3-flash";
if (!task) {
  console.error('usage: node eval/drive.mjs "<task>" [--model id]');
  process.exit(1);
}

const creds = readFileSync(join(homedir(), ".dsh", ".credentials.yaml"), "utf8");
const apiKey = (creds.match(/OPENROUTER_API_KEY:\s*["']?([^"'\s]+)/) || [])[1];
if (!apiKey) { console.error("no OPENROUTER_API_KEY in ~/.dsh/.credentials.yaml"); process.exit(1); }

const systemPrompt = readFileSync(join(ROOT, "eval", "prompt.md"), "utf8");

function log(role, text) {
  appendFileSync(LOG, `\n===== ${role} =====\n${text}\n`);
}

function pilot(cmdJson) {
  try {
    const out = execFileSync(
      "node",
      [join(ROOT, "cli.js"), cmdJson, "--session", SESSION, "--profile", PROFILE],
      { encoding: "utf8", timeout: 70000 },
    );
    return out.trim();
  } catch (e) {
    return (e.stdout || "").trim() + (e.stderr || "").trim() || `driver error: ${e.message}`;
  }
}

// Model may wrap the JSON in fences or prepend reasoning; take the first
// balanced {...} block.
function extractJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

async function ask(messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 4000, temperature: 0.2, messages }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.choices?.[0]?.message?.content ?? "";
}

// Fresh tab for the run.
pilot('{"action":"release"}');
const claim = pilot('{"action":"claim"}');
log("driver", `claim: ${claim}`);

const messages = [
  { role: "system", content: systemPrompt },
  { role: "user", content: `TASK: ${task}` },
];

let outcome = "MAX_STEPS";
for (let step = 1; step <= MAX_STEPS; step++) {
  const reply = await ask(messages);
  log(`model step ${step}`, reply);
  messages.push({ role: "assistant", content: reply });

  if (/^\s*DONE:/m.test(reply)) {
    outcome = reply.match(/DONE:.*$/m)[0];
    break;
  }
  const cmd = extractJson(reply);
  if (!cmd) {
    messages.push({ role: "user", content: 'Reply with ONE JSON action object only, or "DONE: <result>".' });
    continue;
  }
  let result = pilot(cmd);
  if (result.length > 2600) result = result.slice(0, 2600) + "\n...[truncated]";
  log(`pilot step ${step}`, `${cmd}\n--->\n${result}`);
  console.log(`step ${step}: ${cmd.slice(0, 110)}`);
  messages.push({ role: "user", content: `RESULT:\n${result}` });
}

pilot('{"action":"release"}');
console.log(`\noutcome: ${outcome}`);
console.log(`transcript: ${LOG}`);
writeFileSync(LOG + ".outcome", outcome);
