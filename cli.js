#!/usr/bin/env node
// Pilot CLI — the harness-side client for the local relay.
//
//   node cli.js '{"action":"snap"}'
//   node cli.js '{"action":"click","sel":"button.submit"}' --profile work
//   node cli.js '{"action":"shot"}' --out /tmp/page.jpg        # writes image to disk
//   node cli.js --status                                        # who is connected
//
// Screenshot results are written to disk automatically when --out is given
// (default: ~/.pilot/shots/<timestamp>.<ext>). Print the path so the harness
// can OCR or attach the file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const argv = process.argv.slice(2);
const RELAY = process.env.PILOT_RELAY || "ws://127.0.0.1:8756";

function parseArgs(argv) {
  const out = { profile: null, out: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--relay") { /* handled via env, kept for compat */ }
    else if (a === "--status") out.status = true;
    else out.json = a;
  }
  return out;
}

function shotsDir() {
  const dir = path.join(os.homedir(), ".pilot", "shots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function run(cmd, opts) {
  if (opts.status) {
    const status = await request({ action: "status" }, opts);
    console.log(JSON.stringify(status, null, 1));
    return;
  }

  const res = await request(cmd, opts);
  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, error: res.error, queued: res.queued, profile: res.profile }, null, 1));
    process.exit(1);
  }

  const value = res.value;
  // Persist screenshot payloads to disk and report the path.
  if (value && typeof value === "object" && value.dataUrl) {
    const format = value.format || "png";
    const ext = format === "jpeg" || format === "jpg" ? "jpg" : "png";
    const target = opts.out || path.join(shotsDir(), `${Date.now()}.${ext}`);
    const base64 = value.dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
    fs.writeFileSync(target, Buffer.from(base64, "base64"));
    console.log(JSON.stringify({
      ok: true,
      file: target,
      width: value.width,
      height: value.height,
      source: value.source,
      format,
      hint: `read the image at ${target} (e.g. OCR it)`,
    }, null, 1));
    return;
  }

  console.log(JSON.stringify({ ok: true, value }, null, 1));
}

function request(cmd, opts) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const ws = new WebSocket(RELAY);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("timeout — is the relay running? (node server.js)")); }
    }, 60000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ hello: "cli" }));
      ws.send(JSON.stringify({ id, ...cmd, ...(opts.profile ? { profile: opts.profile } : {}) }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "status" && cmd.action === "status") {
        if (!settled) { settled = true; clearTimeout(timer); resolve(m); ws.close(); }
        return;
      }
      if (m.id === id) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(m); ws.close(); }
      }
    });
    ws.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
  });
}

(async () => {
  const opts = parseArgs(argv);
  if (opts.status) return run(null, opts);
  if (!opts.json) {
    console.error("usage: node cli.js '<json command>' [--profile NAME] [--out FILE] | --status");
    process.exit(1);
  }
  let cmd;
  try { cmd = JSON.parse(opts.json); } catch { console.error("bad JSON:", opts.json); process.exit(1); }
  return run(cmd, opts);
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
