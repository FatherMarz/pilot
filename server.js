// Pilot relay — the local hub.
//
//   - Chrome extension (one per Chrome profile) connects here and identifies
//     itself with a profile name. That connection is the handshake: the user
//     must click Connect in the Pilot popup, so a profile only shows up here
//     after an explicit human action.
//   - The harness CLI connects here, targets a profile, and gets replies.
//   - A tiny HTTP GET / endpoint reports who is connected, so tooling and the
//     web page can show live status without a WebSocket client.
//
// One relay serves every Chrome profile on the machine. No pairing tokens, no
// passwords: localhost-only, and the human decides which profiles connect.

const http = require("http");
const WebSocket = require("ws");

const DEFAULT_PORT = Number(process.env.PILOT_PORT || 8756);

function createRelay(port = DEFAULT_PORT) {
  // profileName -> extension WebSocket. A second connect from the same profile
  // (e.g. the user re-opened Chrome) replaces the stale one.
  const extensions = new Map();
  // Commands waiting for a profile that is not connected yet.
  const queued = [];
  // id -> { reply, profile } for in-flight commands.
  const pending = new Map();
  // CLI sockets, so we can push status changes to them.
  const clis = new Set();

  function statusPayload() {
    const now = Date.now();
    return {
      type: "status",
      server: "pilot",
      profiles: [...extensions.entries()].map(([name, ws]) => ({
        name,
        connectedAt: ws.connectedAt,
        age: Math.round((now - ws.connectedAt) / 1000),
      })),
      queued: queued.length,
    };
  }

  function broadcastStatus() {
    const payload = JSON.stringify(statusPayload());
    for (const cli of clis) {
      if (cli.readyState === 1) cli.send(payload);
    }
  }

  // ─── HTTP status endpoint (GET /) ──────────────────────────────────────
  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(statusPayload()));
  });

  const wss = new WebSocket.Server({ server: httpServer });

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    const t0 = Date.now();
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // ── Extension connects: the handshake ─────────────────────────────
      if (msg.hello === "extension") {
        // Profile names are matched case-insensitively so "Work" and
        // "work" are the same profile.
        const profile = String(msg.profile || "default").slice(0, 64).toLowerCase();
        const stale = extensions.get(profile);
        if (stale && stale !== ws) {
          try { stale.close(1000, "replaced by newer Pilot connection"); } catch {}
        }
        ws.hello = "extension";
        ws.profile = profile;
        ws.connectedAt = Date.now();
        extensions.set(profile, ws);
        console.log(`pilot profile "${profile}" connected at`, new Date().toISOString().slice(11, 19));
        ws.send(JSON.stringify({ type: "handshake", ok: true, profile }));
        broadcastStatus();

        // Deliver anything queued for this profile, in order.
        const toDeliver = queued.filter((c) => c.profile === profile);
        if (toDeliver.length) {
          // keep other profiles' queues untouched
          const remaining = queued.filter((c) => c.profile !== profile);
          queued.length = 0;
          queued.push(...remaining);
          for (const cmd of toDeliver) {
            pending.set(cmd.id, { reply: cmd.reply, profile });
            ws.send(JSON.stringify({ id: cmd.id, ...cmd.body }));
          }
          console.log(`delivered ${toDeliver.length} queued cmd(s) to "${profile}"`);
        }
        return;
      }

      // ── CLI connects: tell it who is connected ─────────────────────────
      if (msg.hello === "cli") {
        ws.hello = "cli";
        clis.add(ws);
        ws.send(JSON.stringify(statusPayload()));
        return;
      }

      // ── Extension reply → resolve the pending CLI command ──────────────
      if (ws.hello === "extension") {
        const p = pending.get(msg.id);
        if (p) { p.reply(JSON.stringify(msg)); pending.delete(msg.id); }
        return;
      }

      // ── CLI command → forward to the right profile ─────────────────────
      if (ws.hello === "cli") {
        const profile = String(msg.profile || "default").slice(0, 64).toLowerCase();
        const id = msg.id || Math.floor(Math.random() * 1e9);
        const reply = (s) => ws.send(s);
        const body = { ...msg };
        delete body.id;
        delete body.profile;
        const target = extensions.get(profile);
        if (target && target.readyState === 1) {
          pending.set(id, { reply, profile });
          target.send(JSON.stringify({ id, ...body }));
        } else {
          queued.push({ id, reply, body, profile });
          console.log(`cmd queued for "${profile}" (not connected) at`, new Date().toISOString().slice(11, 19));
          // Tell the CLI immediately that this is queued, not dead.
          ws.send(JSON.stringify({ id, ok: false, error: "queued", queued: true, profile }));
        }
        return;
      }
    });

    ws.on("close", () => {
      if (ws.hello === "extension") {
        if (extensions.get(ws.profile) === ws) {
          extensions.delete(ws.profile);
          console.log(`pilot profile "${ws.profile}" disconnected, age ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          broadcastStatus();
        }
      } else if (ws.hello === "cli") {
        clis.delete(ws);
      }
    });
    ws.on("error", (e) => console.log("pilot conn error:", e.message));
  });

  // Heartbeat: drop dead sockets.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  return {
    wss,
    httpServer,
    statusPayload,
    port: () => (httpServer.address() && httpServer.address().port) || null,
    listen: (p = port, host = "127.0.0.1") =>
      new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(p, host, () => resolve(httpServer.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const cli of clis) { try { cli.terminate(); } catch {} }
        for (const ws of extensions.values()) { try { ws.terminate(); } catch {} }
        wss.close(() => httpServer.close(() => resolve()));
      }),
  };
}

if (require.main === module) {
  const relay = createRelay();
  relay.listen().then((p) => {
    console.log(`pilot relay listening on http://127.0.0.1:${p}`);
    console.log(`open the Pilot popup in any Chrome profile and click Connect to handshake`);
  });
}

module.exports = { createRelay, DEFAULT_PORT };
