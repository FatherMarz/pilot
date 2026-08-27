#!/usr/bin/env node
// Pilot CLI — the harness-side client for the local relay.
//
//   node cli.js '{"action":"snap"}'
//   node cli.js '{"action":"click","sel":"button.submit"}' --profile work
//   node cli.js '{"action":"shot"}' --out /tmp/page.jpg        # writes image to disk
//   node cli.js --status                                        # who is connected
//
// ── SESSIONS (per-agent tab pinning) ───────────────────────────────────────────
// The extension can drive one tab per command, but when several agents (or the
// harness and another app) share a Chrome profile, "the first tab in the Harness
// group" is a shared resource and gets hijacked. A SESSION pins one dedicated tab
// id on disk and injects it into every tab-touching command, so each agent owns a
// tab and another driver can no longer steal it.
//
//   --session NAME      use the pinned tab for NAME (default "default")
//   --tab ID            override: drive this exact tab id this once
//   --window ID         share that existing window instead of the profile window
//   --here              share the window that is focused NOW
//   --new-window        force a brand-new window for this claim
//   --sessions          print the tab pins and per-profile windows
//   claim               (action) get/claim a dedicated tab and print its id
//   release             (action) close the pinned tab and forget it
//   guard               (action) if the pinned tab drifted off the last URL, re-navigate back
//
// Default placement: one shared agent-window per profile (~/.pilot/windows.json).
// The first claim in a profile creates it; every agent working in that profile
// adds its own tab to that same window, so they never compete and the user's
// own windows stay untouched.
//
// The pin lives at ~/.pilot/session.json: { NAME: { tabId, windowId, url } }.
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
  const out = { profile: null, out: null, json: null, session: "default", tab: null, window: null, newWindow: false, here: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--session") out.session = argv[++i] || "default";
    else if (a === "--tab") out.tab = Number(argv[++i]);
    else if (a === "--window") out.window = Number(argv[++i]);
    else if (a === "--new-window") out.newWindow = true;
    else if (a === "--here") out.here = true;
    else if (a === "--relay") { /* handled via env, kept for compat */ }
    else if (a === "--status") out.status = true;
    else if (a === "--sessions") out.sessions = true;
    else out.json = a;
  }
  return out;
}

function shotsDir() {
  const dir = path.join(os.homedir(), ".pilot", "shots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── session state (per-agent tab pin) ──────────────────────────────────────────

function sessionFile() {
  return path.join(os.homedir(), ".pilot", "session.json");
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
  fs.writeFileSync(sessionFile(), JSON.stringify(sessions, null, 1));
}

function getSession(name) {
  return (loadSessions()[name]) || null;
}

function setSession(name, entry) {
  const sessions = loadSessions();
  sessions[name] = entry;
  saveSessions(sessions);
}

function clearSession(name) {
  const sessions = loadSessions();
  delete sessions[name];
  saveSessions(sessions);
}

// ── per-profile shared agent window ─────────────────────────────────────────
// One agent-window per Chrome profile: the first agent in a profile creates
// it, and every agent working in that profile adds its own tab to that same
// window. Recorded at ~/.pilot/windows.json: { PROFILE: windowId }.

function windowsFile() {
  return path.join(os.homedir(), ".pilot", "windows.json");
}

function loadWindows() {
  try {
    return JSON.parse(fs.readFileSync(windowsFile(), "utf8"));
  } catch {
    return {};
  }
}

function saveWindows(windows) {
  fs.mkdirSync(path.dirname(windowsFile()), { recursive: true });
  fs.writeFileSync(windowsFile(), JSON.stringify(windows, null, 1));
}

// Create a dedicated tab for a session. Default: the profile's shared agent
// window (first claim in the profile creates it; later claims add their own
// tab to it). --window / --here opt into sharing a specific window instead.
async function claimTab(opts) {
  let windowId = opts.window;
  if (opts.here && windowId == null) {
    const active = await request({ action: "activeTab" }, opts);
    if (active.ok && active.value) windowId = active.value.windowId;
  }
  if (windowId == null) {
    const profileKey = opts.profile || "default";
    const known = loadWindows()[profileKey];
    if (known != null) {
      const wins = await request({ action: "windows" }, opts).catch(() => null);
      const alive = wins && wins.ok && wins.value && wins.value.some((w) => w.id === known);
      if (alive) windowId = known;
    }
  }
  const created = await request({
    action: "newHarnessTab",
    ...(windowId != null ? { windowId } : { newWindow: true }),
  }, opts);
  if (windowId == null && created.ok && created.value && created.value.windowId) {
    const profileKey = opts.profile || "default";
    const windows = loadWindows();
    windows[profileKey] = created.value.windowId;
    saveWindows(windows);
  }
  return created;
}

// Actions that never touch a tab (mirrors the extension's METADATA_ACTIONS plus
// our own CLI-level convenience actions). They must not claim or create a tab.
const NON_TAB_ACTIONS = new Set([
  "ping", "status", "tabs", "windows", "groups", "activeTab", "tabInfo", "closeTab",
  "harnessTab", "newHarnessTab", "reload", "claim", "release", "guard", "help",
]);

// One screen, everything a driving model needs. Kept in the CLI so it works
// even when the relay or the extension is down.
const HELP = {
  start: [
    `claim a tab once:   node cli.js '{"action":"claim"}' --session myjob`,
    `then reuse it:      add --session myjob to every command`,
    `look before you click: snap first, act second, snap again to confirm`,
  ],
  commands: {
    snap: `{"action":"snap"} — title, url, page text, numbered clickable items`,
    clickN: `{"action":"clickN","n":3} — click item 3 from the last snap (most reliable)`,
    clickText: `{"action":"clickText","text":"Save"} — forgiving match; add "exact":true to pin it`,
    click: `{"action":"click","sel":"button.submit"} — CSS selector`,
    clickXY: `{"action":"clickXY","x":300,"y":500} — viewport coordinates from snap`,
    type: `{"action":"type","text":"hello"} — into the visible field; add "sel" to pick one`,
    replace: `{"action":"replace","sel":"#name","text":"Ada"} — clear the field, then type`,
    fill: `{"action":"fill","sel":"[name=size]","value":"medium"} — set input/select value`,
    fillShadow: `{"action":"fillShadow","match":"email","value":"a@b.c"} — reach fields inside shadow DOM`,
    key: `{"action":"key","key":"Enter"} — add "meta":true or "shift":true`,
    form: `{"action":"form"} — every input/select/radio plus visible error text`,
    findText: `{"action":"findText","text":"Total"} — where text sits on the page`,
    read: `{"action":"read"} — full page text (12000 chars); {"offset":12000} continues`,
    dialog: `{"action":"dialog"} — text of the open dialog, null if none`,
    navigate: `{"action":"navigate","url":"https://example.com"} — waits for the page to load`,
    shot: `{"action":"shot"} — screenshot to ~/.pilot/shots; add --out FILE; read it with ./ocr FILE`,
    tabs: `{"action":"tabs"} — every open tab with ids`,
    claim: `{"action":"claim"} --session NAME — pin a dedicated tab`,
    guard: `{"action":"guard"} --session NAME — pull the tab back if it drifted`,
    release: `{"action":"release"} --session NAME — close the tab and forget it`,
  },
  flags: `--session NAME (always) | --profile NAME | --tab ID | --out FILE | --status | --sessions`,
  errors: `every reply has "ok". On ok:false read "error" and "hint"; most failures include the visible texts or fields to try next.`,
};

async function run(cmd, opts) {
  if (cmd && cmd.action === "help") {
    console.log(JSON.stringify(HELP, null, 1));
    return;
  }

  if (opts.status) {
    const status = await request({ action: "status" }, opts);
    console.log(JSON.stringify(status, null, 1));
    return;
  }

  if (opts.sessions) {
    console.log(JSON.stringify({ sessions: loadSessions(), windows: loadWindows() }, null, 1));
    return;
  }

  // ── claim: get or create a dedicated tab and pin it ───────────────────────
  if (cmd.action === "claim") {
    const existing = getSession(opts.session);
    if (existing && existing.tabId != null) {
      // Verify the pinned tab still exists before reusing it.
      const info = await request({ action: "tabInfo", tabId: existing.tabId }, opts);
      if (info.ok && info.value) {
        console.log(JSON.stringify({ ok: true, session: opts.session, tabId: existing.tabId, windowId: info.value.windowId ?? null, url: info.value.url, reused: true }, null, 1));
        return;
      }
    }
    const created = await claimTab(opts);
    if (!created.ok) {
      console.error(JSON.stringify({ ok: false, error: created.error }, null, 1));
      process.exit(1);
    }
    setSession(opts.session, { tabId: created.value.tabId, url: null, windowId: created.value.windowId ?? null, profile: opts.profile || null });
    console.log(JSON.stringify({ ok: true, session: opts.session, tabId: created.value.tabId, windowId: created.value.windowId ?? null, profile: opts.profile || null, reused: false }, null, 1));
    return;
  }

  // ── release: close the pinned tab and forget it ───────────────────────────
  if (cmd.action === "release") {
    const existing = getSession(opts.session);
    if (existing && existing.tabId != null) {
      await request({ action: "closeTab", tabId: existing.tabId }, opts).catch(() => {});
    }
    clearSession(opts.session);
    console.log(JSON.stringify({ ok: true, session: opts.session, released: true }, null, 1));
    return;
  }

  // ── guard: if the pinned tab drifted off the last URL, pull it back ────────
  if (cmd.action === "guard") {
    const existing = getSession(opts.session);
    if (!existing || existing.tabId == null) {
      console.log(JSON.stringify({ ok: true, guarded: false, note: "no pinned tab" }, null, 1));
      return;
    }
    const info = await request({ action: "tabInfo", tabId: existing.tabId }, opts);
    if (!info.ok || !info.value) {
      // The tab is gone. Re-claim a fresh one.
      const created = await claimTab(opts);
      setSession(opts.session, { tabId: created.value.tabId, url: null, windowId: created.value.windowId ?? null, profile: opts.profile || null });
      console.log(JSON.stringify({ ok: true, guarded: false, note: "tab was gone — re-claimed", tabId: created.value.tabId }, null, 1));
      return;
    }
    const curUrl = info.value.url || "";
    const want = existing.url;
    if (want && curUrl !== want) {
      await request({ action: "navigate", tabId: existing.tabId, url: want }, opts);
      console.log(JSON.stringify({ ok: true, guarded: true, from: curUrl, to: want }, null, 1));
      return;
    }
    console.log(JSON.stringify({ ok: true, guarded: false, url: curUrl }, null, 1));
    return;
  }

  // ── every tab-touching command pins its session tab ───────────────────────
  if (!NON_TAB_ACTIONS.has(cmd.action)) {
    // Precedence: (1) an explicit --tab flag, (2) a tabId already in the command
    // JSON, (3) the session pin, (4) claim a fresh one. Respecting an inline
    // tabId keeps read-only probes like `tabInfo`/`closeTab` from auto-claiming.
    let tabId = opts.tab ?? (typeof cmd.tabId === "number" ? cmd.tabId : null);
    if (tabId == null) {
      const existing = getSession(opts.session);
      if (existing && existing.tabId != null) {
        // Verify the pinned tab still exists; if not, fall through and re-claim.
        const info = await request({ action: "tabInfo", tabId: existing.tabId }, opts);
        if (info.ok && info.value) tabId = existing.tabId;
      }
    }
    if (tabId == null) {
      const created = await claimTab(opts);
      tabId = created.value.tabId;
      setSession(opts.session, { tabId, url: null, windowId: created.value.windowId ?? null, profile: opts.profile || null });
    }
    cmd = { ...cmd, tabId };
  }

  const res = await request(cmd, opts);
  if (!res.ok) {
    console.error(JSON.stringify({ ok: false, error: res.error, queued: res.queued, profile: res.profile }, null, 1));
    process.exit(1);
  }

  // Remember where a navigate landed, so `guard` can pull the tab back.
  if (cmd.action === "navigate" && cmd.tabId != null) {
    const existing = getSession(opts.session);
    setSession(opts.session, { tabId: cmd.tabId, url: cmd.url || null, windowId: existing?.windowId ?? null, profile: existing?.profile ?? null });
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
      // Auto-inject the session's pinned profile when no --profile was given,
      // so a `/bridge <profile>` claim keeps every later command in that profile.
      const profile = opts.profile || (getSession(opts.session || "default") || {}).profile || null;
      ws.send(JSON.stringify({ id, ...cmd, ...(profile ? { profile } : {}) }));
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
  if (opts.sessions) return run(null, opts);
  if (!opts.json) {
    console.error("usage: node cli.js '<json command>' [--profile NAME] [--session NAME] [--tab ID] [--window ID | --here | --new-window] [--out FILE] | --status | --sessions");
    console.error(`try: node cli.js '{"action":"help"}'`);
    process.exit(1);
  }
  let cmd;
  try {
    cmd = JSON.parse(opts.json);
  } catch {
    console.error(JSON.stringify({
      ok: false,
      error: "bad JSON: " + opts.json,
      hint: `single-quote the whole command, double-quote the keys. Example: node cli.js '{"action":"snap"}' --session myjob`,
    }, null, 1));
    process.exit(1);
  }
  if (!cmd || typeof cmd !== "object" || !cmd.action) {
    console.error(JSON.stringify({ ok: false, error: "command needs an \"action\" key", hint: `node cli.js '{"action":"help"}'` }, null, 1));
    process.exit(1);
  }
  return run(cmd, opts);
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
