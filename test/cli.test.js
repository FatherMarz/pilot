// CLI tests: session reuse + adoption, staleness, gc hint, sessions board view.
// Runs cli.js as a subprocess against a real relay with a scripted fake
// extension, and points HOME at a temp dir so real pins are never touched.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");
const { createRelay } = require("../server.js");

const CLI = path.join(__dirname, "..", "cli.js");

// ── fixtures ────────────────────────────────────────────────────────────────

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pilot-test-"));
}

// Fake extension: connects as `profile` and answers every command with the
// given handler's JSON value (or { ok: true, value } when it returns nothing).
function fakeExtension(port, profile, handler) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => ws.send(JSON.stringify({ hello: "extension", profile })));
  ws.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === "handshake" || !msg.id) return;
    const value = handler ? handler(msg) : { url: "https://example.com/" };
    ws.send(JSON.stringify({ id: msg.id, ok: true, value: value === undefined ? null : value }));
  });
  return ws;
}

function runCli(args, homeDir, port) {
  return new Promise((resolve) => {
    const p = process.execPath;
    const child = spawn(p, [path.join(__dirname, "..", "cli.js"), ...args], {
      env: { ...process.env, HOME: homeDir, PILOT_RELAY: `ws://127.0.0.1:${port}` },
      cwd: __dirname,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ raw: out }); }
    });
  });
}

// cli.js reads the relay URL from the PILOT_RELAY_WS env var? If it does not,
// fall back to the default 127.0.0.1:8756 — see request() in cli.js.

test("claim adopts an idle session's tab instead of opening a new one", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const ext = fakeExtension(port, "work", (msg) => {
    if (msg.action === "tabInfo") return { id: msg.tabId, url: "https://example.com/", windowId: 1 };
    if (msg.action === "tabs") return [{ id: 42, url: "https://example.com/", groupId: -1, windowId: 1 }];
    return null;
  });
  t.after(() => ext.close());

  // Seed a stale pin directly into the temp HOME's session.json.
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({
    old: { tabId: 42, url: null, windowId: 1, profile: "work", lastUsed: Date.now() - 60 * 60000 },
  }));

  const out = await runCli(['{"action":"claim"}', "--session", "fresh", "--profile", "work"], home, port);
  assert.equal(out.ok, true);
  assert.equal(out.reused, true, "claim should report reuse");
  assert.equal(out.adoptedFrom, "old", "claim should adopt the idle session");
  assert.equal(out.tabId, 42);
  const pins = JSON.parse(fs.readFileSync(path.join(home, ".pilot", "session.json")));
  assert.ok(pins.fresh, "new session owns the pin");
  assert.ok(!pins.old, "adopted session is gone");
});

test("claim skips tabs of other profiles", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // The extension is the "work" profile; the stale pin belongs to "other", so
  // claim must not adopt it and must open a fresh tab instead.
  const ext = fakeExtension(port, "work", (msg) => {
    if (msg.action === "tabInfo") return { id: 42, url: "about:blank", windowId: 1 };
    if (msg.action === "newHarnessTab") return { id: 7, windowId: 1 };
    return null;
  });
  t.after(() => ext.close());

  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({
    old: { tabId: 42, url: null, windowId: 1, profile: "other", lastUsed: Date.now() - 60 * 60000 },
  }));

  const out = await runCli(['{"action":"claim"}', "--session", "fresh", "--profile", "work"], home, port);
  assert.equal(out.ok, true);
  assert.equal(out.adoptedFrom, undefined, "must not adopt another profile's tab");
  assert.equal(out.reused, false);
});

test("--sessions shows staleness and the gc hint once 3+ sessions are stale", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const ext = fakeExtension(port, "work", (msg) => {
    if (msg.action === "tabs") return [{ id: 1, url: "https://x.test/", groupId: -1 }, { id: 2, url: "about:blank", groupId: -1 }, { id: 3, url: "about:blank", groupId: -1 }, { id: 4, url: "about:blank", groupId: -1 }];
    return null;
  });
  t.after(() => ext.close());

  const old = Date.now() - 90 * 60000;
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({
    a: { tabId: 1, url: null, windowId: 1, profile: "work", lastUsed: old },
    b: { tabId: 2, url: null, windowId: 1, profile: "work", lastUsed: old },
    c: { tabId: 3, url: null, windowId: 1, profile: "work", lastUsed: old },
    fresh: { tabId: 4, url: null, windowId: 1, profile: "work", lastUsed: Date.now() },
  }));

  const out = await runCli(["--sessions", "--profile", "work", "--stale-minutes", "30"], home, port);
  assert.equal(out.sessions.a.stale, true);
  assert.equal(out.sessions.fresh.stale, false);
  assert.equal(out.sessions.a.idleMin >= 90, true);
  assert.match(out.hint, /gc --keep/);

  // With fewer stale sessions than 3, no hint.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home2, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home2, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home2, ".pilot", "session.json"), JSON.stringify({
    a: { tabId: 1, url: null, windowId: 1, profile: "work", lastUsed: old },
  }));
  const out2 = await runCli(["--sessions", "--profile", "work", "--stale-minutes", "30"], home2, port);
  assert.equal(out2.hint, undefined);
});
