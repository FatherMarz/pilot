// Relay tests: handshake, multi-profile routing, queuing, status, HTTP endpoint.
const { test } = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { createRelay } = require("../server.js");

const URL = (port) => `ws://127.0.0.1:${port}`;

function connect(port, hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL(port));
    ws.messages = [];
    ws.on("message", (d) => ws.messages.push(JSON.parse(d.toString())));
    ws.on("open", () => {
      if (hello) ws.send(JSON.stringify(hello));
      resolve(ws);
    });
    ws.on("error", reject);
  });
}

const next = (ws, predicate, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeout);
    const scan = () => {
      const i = ws.messages.findIndex(predicate);
      if (i >= 0) {
        clearTimeout(t);
        const [m] = ws.messages.splice(i, 1);
        resolve(m);
      }
    };
    ws.on("message", scan);
    scan();
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("handshake: extension registers a profile and gets ack", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension", profile: "work" });
  const ack = await next(ext, (m) => m.type === "handshake");
  assert.equal(ack.ok, true);
  assert.equal(ack.profile, "work");

  const cli = await connect(port, { hello: "cli" });
  const status = await next(cli, (m) => m.type === "status");
  assert.deepEqual(status.profiles.map((p) => p.name), ["work"]);
});

test("profile defaults to 'default' when omitted", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension" });
  const ack = await next(ext, (m) => m.type === "handshake");
  assert.equal(ack.profile, "default");
});

test("two profiles connect side by side", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const a = await connect(port, { hello: "extension", profile: "work" });
  const b = await connect(port, { hello: "extension", profile: "personal" });
  await next(a, (m) => m.type === "handshake");
  await next(b, (m) => m.type === "handshake");

  const cli = await connect(port, { hello: "cli" });
  const status = await next(cli, (m) => m.type === "status");
  assert.deepEqual(status.profiles.map((p) => p.name).sort(), ["personal", "work"]);
});

test("reconnecting the same profile replaces the stale socket", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const first = await connect(port, { hello: "extension", profile: "work" });
  await next(first, (m) => m.type === "handshake");

  const second = await connect(port, { hello: "extension", profile: "work" });
  await next(second, (m) => m.type === "handshake");

  await wait(50);
  assert.equal(first.readyState, WebSocket.CLOSED, "first socket should be closed");
});

test("cli command routes to the targeted profile and reply returns", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension", profile: "work" });
  await next(ext, (m) => m.type === "handshake");

  const cli = await connect(port, { hello: "cli" });
  cli.send(JSON.stringify({ id: 77, action: "ping", profile: "work" }));
  const cmd = await next(ext, (m) => m.id === 77);
  assert.equal(cmd.action, "ping");
  ext.send(JSON.stringify({ id: 77, ok: true, value: "v7" }));
  const reply = await next(cli, (m) => m.id === 77);
  assert.equal(reply.ok, true);
  assert.equal(reply.value, "v7");
});

test("command for a disconnected profile is queued, then delivered on connect", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const cli = await connect(port, { hello: "cli" });
  cli.send(JSON.stringify({ id: 5, action: "snap", profile: "late" }));
  const queued = await next(cli, (m) => m.id === 5);
  assert.equal(queued.queued, true);

  const ext = await connect(port, { hello: "extension", profile: "late" });
  await next(ext, (m) => m.type === "handshake");
  const cmd = await next(ext, (m) => m.id === 5);
  assert.equal(cmd.action, "snap");
});

test("commands to a different profile are not delivered to the connected one", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension", profile: "work" });
  await next(ext, (m) => m.type === "handshake");

  const cli = await connect(port, { hello: "cli" });
  cli.send(JSON.stringify({ id: 9, action: "ping", profile: "other" }));
  const queued = await next(cli, (m) => m.id === 9);
  assert.equal(queued.queued, true);

  await wait(100);
  const got = ext.messages.filter((m) => m.id === 9);
  assert.equal(got.length, 0, "must not leak to another profile");
});

test("disconnecting a profile removes it from status", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension", profile: "work" });
  await next(ext, (m) => m.type === "handshake");
  ext.close();
  await wait(80);

  const cli = await connect(port, { hello: "cli" });
  const status = await next(cli, (m) => m.type === "status");
  assert.equal(status.profiles.length, 0);
});

test("HTTP GET / reports profiles", async (t) => {
  const relay = createRelay(0);
  const port = await relay.listen(0);
  t.after(() => relay.close());

  const ext = await connect(port, { hello: "extension", profile: "work" });
  await next(ext, (m) => m.type === "handshake");

  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.server, "pilot");
  assert.deepEqual(body.profiles.map((p) => p.name), ["work"]);
});
