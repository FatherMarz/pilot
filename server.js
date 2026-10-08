// Pilot relay — the local hub.
//
//   - Chrome extension (one per Chrome profile) connects here and identifies
//     itself with a profile name. That connection is the handshake: the user
//     must click Connect in the Pilot popup, so a profile only shows up here
//     after an explicit human action.
//   - The harness CLI connects here, targets a profile, and gets replies.
//     Commands are never queued: a page action for a profile that is not
//     connected fails at once. Only read-only metadata (status, tabs, ...)
//     waits up to 4s for a reconnect, then fails.
//   - A tiny HTTP GET / endpoint reports who is connected, so tooling and the
//     web page can show live status without a WebSocket client.
//
// One relay serves every Chrome profile on the machine. No pairing tokens, no
// passwords: localhost-only, and the human decides which profiles connect.

const http = require("http");
const WebSocket = require("ws");

const DEFAULT_PORT = Number(process.env.PILOT_PORT || 8756);

function createRelay(port = DEFAULT_PORT, opts = {}) {
  const waitMs = opts.waitMs != null ? opts.waitMs : 4000;
  // profileName -> extension WebSocket. A second connect from the same profile
  // (e.g. the user re-opened Chrome) replaces the stale one.
  const extensions = new Map();
  // Read-only metadata commands that may wait briefly for a reconnecting
  // profile (an extension reload drops the socket for ~1-3s). Nothing else is
  // ever held: a page action that arrives while its profile is away fails at
  // once, so it can never replay late after the CLI already reported failure.
  const WAITABLE = new Set(["ping", "status", "tabs", "windows", "activeTab", "tabInfo"]);
  const waiting = []; // { id, reply, body, profile, timer }
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
      waiting: waiting.length,
    };
  }

  function notConnected(id, profile) {
    const names = [...extensions.keys()];
    return {
      id, ok: false, notConnected: true, profile,
      error: "profile '" + profile + "' not connected — ask the user to click Connect in the Pilot popup",
      hint: names.length ? "connected profiles: " + names.join(", ") + " (pass --profile NAME)" : "no Chrome profile is connected to the relay; nothing was sent",
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

        // Deliver the read-only commands that were waiting for this profile.
        for (let i = waiting.length - 1; i >= 0; i--) {
          const w = waiting[i];
          if (w.profile !== profile) continue;
          waiting.splice(i, 1);
          clearTimeout(w.timer);
          pending.set(w.id, { reply: w.reply, profile });
          ws.send(JSON.stringify({ id: w.id, ...w.body }));
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
        } else if (WAITABLE.has(body.action)) {
          const w = { id, reply, body, profile };
          w.timer = setTimeout(() => {
            const i = waiting.indexOf(w);
            if (i >= 0) waiting.splice(i, 1);
            reply(JSON.stringify(notConnected(id, profile)));
          }, waitMs);
          waiting.push(w);
        } else {
          ws.send(JSON.stringify(notConnected(id, profile)));
        }
        return;
      }
    });

    ws.on("close", () => {
      if (ws.hello === "extension") {
        if (extensions.get(ws.profile) === ws) {
          extensions.delete(ws.profile);
          // In-flight commands on this socket will never get an answer.
          for (const [id, p] of pending) {
            if (p.profile !== ws.profile) continue;
            pending.delete(id);
            p.reply(JSON.stringify({ id, ok: false, error: "the Pilot extension disconnected before answering (it may have reloaded); the action may or may not have run", hint: "check with snap before retrying" }));
          }
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
        for (const w of waiting) clearTimeout(w.timer);
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
