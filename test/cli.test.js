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
    if (value && value.__fail) return ws.send(JSON.stringify({ id: msg.id, ok: false, error: value.__fail }));
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
  assert.match(out.hint, /node cli\.js gc/);

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

test("claim drops pins whose tab is gone and auto-releases pins idle over 24h", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const closed = [];
  const ext = fakeExtension(port, "work", (msg) => {
    if (msg.action === "tabInfo") {
      if (msg.tabId === 1) return { __fail: "No tab with id: 1." };
      return { id: msg.tabId, url: "https://example.com/", windowId: 1 };
    }
    if (msg.action === "closeTab") { closed.push(msg.tabId); return { ok: true }; }
    if (msg.action === "newHarnessTab") return { tabId: 9, windowId: 1 };
    if (msg.action === "windows") return [];
    return null;
  });
  t.after(() => ext.close());

  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({
    dead: { tabId: 1, profile: "work", lastUsed: Date.now() },
    ancient: { tabId: 2, profile: "work", lastUsed: Date.now() - 25 * 3600000 },
    recent: { tabId: 3, profile: "work", lastUsed: Date.now() },
    otherProfile: { tabId: 4, profile: "home", lastUsed: Date.now() - 25 * 3600000 },
  }));

  const out = await runCli(['{"action":"claim"}', "--session", "fresh", "--profile", "work", "--no-reuse"], home, port);
  assert.equal(out.ok, true);
  assert.deepEqual(out.pruned.dropped, ["dead"]);
  assert.deepEqual(out.pruned.released, ["ancient"]);
  assert.deepEqual(closed, [2], "only the idle tab is closed");
  const pins = JSON.parse(fs.readFileSync(path.join(home, ".pilot", "session.json")));
  assert.deepEqual(Object.keys(pins).sort(), ["fresh", "otherProfile", "recent"]);
});

test("a page action on an unclaimed session fails and opens no tab", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const seen = [];
  const ext = fakeExtension(port, "default", (msg) => { seen.push(msg.action); return { tabId: 5, windowId: 1 }; });
  t.after(() => ext.close());
  await new Promise((r) => setTimeout(r, 50));
  for (const cmd of ['{"action":"snap"}', '{"action":"navigate","url":"https://example.com"}', '{"action":"click","ref":"p1r1"}']) {
    const res = await runCli([cmd, "--session", "typo"], home, port);
    assert.equal(res.ok, false);
    assert.match(res.error, /no tab for session typo — run claim first/);
  }
  assert.deepEqual(seen, [], "nothing may reach the extension");
});

test("the top-level ok is the truth: value.ok, error and hint are lifted", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({ s: { tabId: 3, lastUsed: Date.now() } }));
  const ext = fakeExtension(port, "default", (msg) => {
    if (msg.action === "click") return { ok: false, error: "no element", hint: "snap again", visibleTexts: ["Save"] };
    return { ok: true };
  });
  t.after(() => ext.close());
  await new Promise((r) => setTimeout(r, 50));
  const res = await runCli(['{"action":"click","ref":"p1r9"}', "--session", "s"], home, port);
  assert.equal(res.ok, false);
  assert.equal(res.error, "no element");
  assert.equal(res.hint, "snap again");
  assert.deepEqual(res.value, { visibleTexts: ["Save"] });
});

test("unknown actions fail in the CLI with the nearest match", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  const res = await runCli(['{"action":"clik","ref":"p1r1"}', "--session", "s"], home, 1);
  assert.equal(res.ok, false);
  assert.match(res.hint, /did you mean "click"/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("relay-level failures keep their hint (not connected)", async (t) => {
  const relay = createRelay(0, { waitMs: 100 });
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({ s: { tabId: 3, lastUsed: Date.now() } }));
  const res = await runCli(['{"action":"snap"}', "--session", "s"], home, port);
  assert.equal(res.ok, false);
  assert.match(res.error, /not connected/);
  assert.ok(res.hint);
});

test("gc releases only stale sessions, never live ones", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const released = [];
  const ext = fakeExtension(port, "default", (msg) => {
    if (msg.action === "releaseTab") { released.push(msg.tabId); return { ok: true, closed: [msg.tabId], ungrouped: [], leftOpen: [] }; }
    if (msg.action === "cleanup") return { ok: true, close: [], ungroup: [] };
    return null;
  });
  t.after(() => ext.close());
  await new Promise((r) => setTimeout(r, 50));
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({
    me: { tabId: 1, lastUsed: Date.now() },
    otherLive: { tabId: 2, lastUsed: Date.now() - 5 * 60000 },
    old: { tabId: 3, lastUsed: Date.now() - 90 * 60000 },
  }));
  const res = await runCli(["gc", "--session", "me"], home, port);
  assert.equal(res.ok, true);
  assert.deepEqual(res.released, ["old"]);
  assert.deepEqual(released, [3]);
  const pins = JSON.parse(fs.readFileSync(path.join(home, ".pilot", "session.json")));
  assert.deepEqual(Object.keys(pins).sort(), ["me", "otherLive"]);
});

test("compact snap is the CLI default; full:true keeps JSON", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".pilot"), { recursive: true });
  fs.writeFileSync(path.join(home, ".pilot", "session.json"), JSON.stringify({ s: { tabId: 3, lastUsed: Date.now() } }));
  const ext = fakeExtension(port, "default", () => ({ doc: 2, title: "T", url: "https://x.test/", text: "hello", items: [{ n: 0, ref: "p2r1", role: "button", name: "Save", pri: 1 }] }));
  t.after(() => ext.close());
  await new Promise((r) => setTimeout(r, 50));
  const raw = await runCli(['{"action":"snap"}', "--session", "s"], home, port);
  assert.match(raw.raw, /^ok:true page p2 "T"/);
  assert.match(raw.raw, /\np2r1 button "Save"\n/);
  const full = await runCli(['{"action":"snap","full":true}', "--session", "s"], home, port);
  assert.equal(full.ok, true);
  assert.equal(full.value.items[0].ref, "p2r1");
});
