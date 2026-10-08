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
// harness and another app) share a Chrome profile, "the first tab in the Pilot
// group" is a shared resource and gets hijacked. A SESSION pins one dedicated tab
// id on disk and injects it into every tab-touching command, so each agent owns a
// tab and another driver can no longer steal it.
//
//   --session NAME      use the pinned tab for NAME (default "default")
//   --tab ID            override: drive this exact tab id this once
//   --window ID         share that existing window instead of the profile window
//   --here              share the window that is focused NOW (the default)
//   --new-window        use the profile's own agent window, not the user's
//   --sessions          print the tab pins and per-profile windows
//   claim               (action) get/claim a dedicated tab and print its id
//   release             (action) close the pinned tab (and tabs it opened), forget it
//
// A session must be claimed before it can drive anything: a page action on an
// unknown session (a typo, a forgotten claim) fails with "run claim first"
// instead of quietly opening a new tab. A pinned tab that was closed fails
// the same way and its pin is dropped.
//   guard               (action) if the pinned tab drifted off the last URL, re-navigate back
//
// Default placement: a background tab in the window the user is using (never
// brought forward). --new-window uses one shared agent window per profile
// (~/.pilot/windows.json) instead.
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
const { KNOWN, helpText, unknownAction, shapeReply, formatSnap } = require("./format.js");

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
    else if (a === "gc") out.json = '{"action":"gc"}';
    else if (a === "--keep") out.keep = argv[++i];
    else if (a === "--no-reuse") out.noReuse = true;
    else if (a === "--stale-minutes") out.staleMinutes = Number(argv[++i]);
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
  sessions[name] = { lastUsed: Date.now(), ...entry };
  saveSessions(sessions);
}

function clearSession(name) {
  const sessions = loadSessions();
  delete sessions[name];
  saveSessions(sessions);
}

// Mark a pinned session as just-used, so "idle" staleness means "the agent
// really stopped talking to this tab", not "never touched it".
function touchSession(name) {
  try {
    const sessions = loadSessions();
    if (sessions[name]) {
      sessions[name].lastUsed = Date.now();
      saveSessions(sessions);
    }
  } catch {}
}

// ── session reuse ───────────────────────────────────────────────────────────
// A session idle longer than this (default 30 min) is fair game for adoption:
// a later claim re-pins its tab instead of opening yet another one. Override
// with --stale-minutes N; --no-reuse always opens a fresh tab.

const STALE_DEFAULT_MIN = 30;

function staleMs(opts) {
  const min = opts.staleMinutes != null ? opts.staleMinutes : STALE_DEFAULT_MIN;
  return min * 60000;
}

function profileKey(p) {
  return String(p || "default").toLowerCase();
}

// Find the best tab to adopt: same profile, idle past the threshold, tab still
// alive. Blank tabs win over real pages; older idles win among equals.
async function findAdoptable(opts) {
  const sessions = loadSessions();
  const mine = profileKey(opts.profile);
  const now = Date.now();
  const candidates = [];
  for (const [name, pin] of Object.entries(sessions)) {
    if (!pin || pin.tabId == null) continue;
    const age = now - (pin.lastUsed || 0);
    if (age < staleMs(opts)) continue;
    if (profileKey(pin.profile) !== mine) continue;
    const info = await request({ action: "tabInfo", tabId: pin.tabId }, opts).catch(() => null);
    if (!info || !info.ok || !info.value) continue;
    candidates.push({
      name,
      pin,
      age,
      url: info.value.url || "",
      windowId: info.value.windowId ?? null,
      blankness: (info.value.url || "").startsWith("about:blank") ? 0 : 1,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.blankness - b.blankness || b.age - a.age);
  return candidates[0];
}

// Prune pins on every claim: drop pins whose tab is gone, and auto-release
// (close the tab, forget the pin) sessions idle longer than 24h. Only pins of
// the profile we are talking to are checked; a tab counts as gone only when
// the extension says so, never on a timeout or relay error.
const RELEASE_IDLE_MS = 24 * 60 * 60000;

async function pruneSessions(opts) {
  const sessions = loadSessions();
  const mine = profileKey(opts.profile);
  const now = Date.now();
  const dropped = [];
  const released = [];
  await Promise.all(Object.entries(sessions).map(async ([name, pin]) => {
    if (!pin || pin.tabId == null || profileKey(pin.profile) !== mine) return;
    const info = await request({ action: "tabInfo", tabId: pin.tabId }, opts).catch(() => null);
    if (!info) return;
    if (!info.ok) {
      if (/no tab/i.test(String(info.error || ""))) dropped.push(name);
      return;
    }
    if (name !== opts.session && now - (pin.lastUsed || 0) > RELEASE_IDLE_MS) {
      await request({ action: "closeTab", tabId: pin.tabId }, opts).catch(() => {});
      released.push(name);
    }
  }));
  if (dropped.length || released.length) {
    const fresh = loadSessions();
    for (const n of [...dropped, ...released]) delete fresh[n];
    saveSessions(fresh);
  }
  return { dropped, released };
}

// If idle sessions are piling up, say so and name the exact cleanup command.
function gcHint(opts) {
  const sessions = loadSessions();
  const names = Object.keys(sessions);
  const now = Date.now();
  const stale = names.filter((n) => {
    const lu = sessions[n] && sessions[n].lastUsed;
    return !lu || now - lu > staleMs(opts);
  }).length;
  if (stale < 3) return null;
  return `${stale} stale of ${names.length} session(s) — run: node cli.js gc (releases only sessions idle over ${Math.round(staleMs(opts) / 60000)} min)`;
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

// Create a dedicated tab for a session. Default: a background tab in the
// window the user is in, which Pilot never brings forward. --window picks a
// window, --new-window uses the profile's own agent window instead (first claim
// creates it, later ones add a tab). With no focused window, the agent window.
async function claimTab(opts) {
  let windowId = opts.window;
  if (windowId == null && !opts.newWindow) {
    const active = await request({ action: "activeTab" }, opts).catch(() => null);
    if (active && active.ok && active.value) windowId = active.value.windowId;
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

// Actions that never touch a tab: they must not resolve a session tab.
const NON_TAB_ACTIONS = new Set([
  "ping", "status", "tabs", "windows", "groups", "activeTab", "tabInfo", "closeTab",
  "harnessTab", "newHarnessTab", "reload", "claim", "release", "guard", "help", "gc", "cleanup", "releaseTab",
]);

let exitCode = 0;
function out(obj) {
  if (obj && obj.ok === false) exitCode = 1;
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj));
}

// Tab ids of sessions that are still live (used within the stale threshold).
function liveTabIds(opts, except) {
  const sessions = loadSessions();
  const now = Date.now();
  return Object.entries(sessions)
    .filter(([n, p]) => n !== except && p && p.tabId != null && now - (p.lastUsed || 0) <= staleMs(opts))
    .map(([, p]) => p.tabId);
}

async function run(cmd, opts) {
  if (cmd && cmd.action === "help") {
    console.log(helpText());
    return;
  }

  if (opts.status) {
    const status = await request({ action: "status" }, opts);
    out(status);
    return;
  }

  if (opts.sessions) {
    // Join the pins against the live tab list so agents see, per session:
    // is the tab still there, what is it on, how long has it been idle.
    const sessions = loadSessions();
    const listing = await request({ action: "tabs" }, opts).catch(() => null);
    const tabMap = new Map((listing && listing.ok ? listing.value : []).map((t) => [t.id, t]));
    const now = Date.now();
    const view = {};
    for (const [name, pin] of Object.entries(sessions)) {
      const tab = pin && pin.tabId != null ? tabMap.get(pin.tabId) : null;
      const lastUsed = pin && pin.lastUsed;
      view[name] = {
        profile: profileKey(pin && pin.profile),
        tabId: pin ? pin.tabId : null,
        alive: !!tab,
        url: tab ? tab.url : (pin && pin.url) || null,
        idleMin: lastUsed ? Math.round((now - lastUsed) / 60000) : null,
        stale: !lastUsed || now - lastUsed > staleMs(opts),
        adoptedFrom: (pin && pin.adoptedFrom) || undefined,
      };
    }
    const staleCount = Object.values(view).filter((s) => s.stale).length;
    const hint = staleCount >= 3 ? gcHint(opts) || undefined : undefined;
    console.log(JSON.stringify({ sessions: view, windows: loadWindows(), ...(hint ? { hint } : {}) }, null, 1));
    return;
  }

  if (!KNOWN.has(cmd.action)) {
    out(unknownAction(cmd.action));
    return;
  }

  // ── claim: get or create a dedicated tab and pin it ───────────────────────
  if (cmd.action === "claim") {
    touchSession(opts.session);
    const pruned = await pruneSessions(opts);
    const prunedNote = pruned.dropped.length || pruned.released.length ? { pruned } : {};
    const hint = gcHint(opts);
    const done = async (payload) => {
      // Every claim also sweeps orphan Pilot tabs (blank, crashed, or idle
      // past the limit) that no live session pins.
      const keep = liveTabIds(opts).concat(payload.tabId != null ? [payload.tabId] : []);
      const sw = await request({ action: "cleanup", apply: true, keepTabIds: keep }, opts).catch(() => null);
      const swept = sw && sw.ok && sw.value && sw.value.close ? sw.value.close.length : 0;
      out({ ...payload, ...prunedNote, ...(swept ? { swept } : {}), ...(hint ? { hint } : {}) });
    };
    const existing = getSession(opts.session);
    if (existing && existing.tabId != null) {
      const info = await request({ action: "tabInfo", tabId: existing.tabId }, opts);
      if (info.ok && info.value) {
        touchSession(opts.session);
        return done({ ok: true, session: opts.session, tabId: existing.tabId, windowId: info.value.windowId ?? null, url: info.value.url, reused: true });
      }
      if (info.notConnected) return out(shapeReply(info));
    }
    // No live pin of our own: adopt an idle session's tab before opening a
    // fresh one. Keeps agent windows and Pilot groups from multiplying.
    if (!opts.noReuse) {
      const idle = await findAdoptable(opts);
      if (idle) {
        const sessions = loadSessions();
        delete sessions[idle.name];
        sessions[opts.session] = { lastUsed: Date.now(), tabId: idle.pin.tabId, url: null, windowId: idle.windowId, profile: opts.profile || idle.pin.profile || null, adoptedFrom: idle.name };
        saveSessions(sessions);
        return done({ ok: true, session: opts.session, tabId: idle.pin.tabId, windowId: idle.windowId, url: idle.url, reused: true, adoptedFrom: idle.name });
      }
    }
    const created = await claimTab(opts);
    if (!created.ok) return out(shapeReply(created));
    setSession(opts.session, { tabId: created.value.tabId, url: null, windowId: created.value.windowId ?? null, profile: opts.profile || null });
    return done({ ok: true, session: opts.session, tabId: created.value.tabId, windowId: created.value.windowId ?? null, profile: opts.profile || null, reused: false, hint: "now navigate: {\"action\":\"navigate\",\"url\":\"https://...\"}" });
  }

  // ── release: close the pinned tab (and every tab it opened), forget it ────
  if (cmd.action === "release") {
    const existing = getSession(opts.session);
    let res = null;
    if (existing && existing.tabId != null) {
      res = await request({ action: "releaseTab", tabId: existing.tabId }, opts).catch((e) => ({ ok: false, error: String(e.message || e) }));
    }
    clearSession(opts.session);
    const v = res && res.ok ? res.value : null;
    out({ ok: true, session: opts.session, released: true, ...(v ? { closed: v.closed, ...(v.ungrouped.length ? { ungrouped: v.ungrouped, note: v.note } : {}), ...(v.leftOpen.length ? { leftOpen: v.leftOpen } : {}) } : {}), ...(res && !res.ok ? { warning: res.error } : {}) });
    return;
  }

  // ── gc: release STALE sessions only, then sweep orphan Pilot tabs ─────────
  if (cmd.action === "gc") {
    const keep = opts.keep || opts.session;
    const sessions = loadSessions();
    const now = Date.now();
    const released = [];
    for (const [name, pin] of Object.entries(sessions)) {
      if (name === keep) continue;
      const idle = now - ((pin && pin.lastUsed) || 0);
      if (idle <= staleMs(opts)) continue; // live: someone is using it
      if (pin && pin.tabId != null) {
        await request({ action: "releaseTab", tabId: pin.tabId }, { ...opts, profile: pin.profile || opts.profile }).catch(() => {});
      }
      released.push(name);
    }
    const fresh = loadSessions();
    for (const n of released) delete fresh[n];
    saveSessions(fresh);
    const keepTabs = Object.values(fresh).map((p) => p && p.tabId).filter((x) => x != null);
    const sweep = await request({ action: "cleanup", apply: true, keepTabIds: keepTabs }, opts).catch((e) => ({ ok: false, error: String(e.message || e) }));
    out({ ok: true, released, kept: Object.keys(fresh), sweep: sweep.ok ? { closed: (sweep.value.close || []).length, ungrouped: (sweep.value.ungroup || []).length } : sweep.error });
    return;
  }

  // ── cleanup: dry run by default; live sessions are always protected ──────
  if (cmd.action === "cleanup") {
    const keep = Object.values(loadSessions()).filter((p) => p && p.tabId != null && Date.now() - (p.lastUsed || 0) <= staleMs(opts)).map((p) => p.tabId);
    const res = await request({ action: "cleanup", apply: !!cmd.apply, keepTabIds: keep.concat(cmd.keepTabIds || []) }, opts);
    out(shapeReply(res));
    return;
  }

  // ── guard: if the pinned tab drifted off the last URL, pull it back ────────
  if (cmd.action === "guard") {
    const existing = getSession(opts.session);
    if (!existing || existing.tabId == null) {
      out({ ok: false, error: "no tab for session " + opts.session + " — run claim first", hint: `node cli.js '{"action":"claim"}' --session ${opts.session}` });
      return;
    }
    const info = await request({ action: "tabInfo", tabId: existing.tabId }, opts);
    if (!info.ok || !info.value) {
      if (/no tab|gone/i.test(String(info.error || ""))) clearSession(opts.session);
      out({ ok: false, error: "the tab for session " + opts.session + " is gone — run claim", hint: `node cli.js '{"action":"claim"}' --session ${opts.session}` });
      return;
    }
    touchSession(opts.session);
    const curUrl = info.value.url || "";
    const want = existing.url;
    if (want && curUrl !== want) {
      const r = await request({ action: "navigate", tabId: existing.tabId, url: want, session: opts.session }, opts);
      out({ ...shapeReply(r), guarded: true, from: curUrl, to: want });
      return;
    }
    out({ ok: true, guarded: false, url: curUrl });
    return;
  }

  // ── every tab-touching command drives the session's pinned tab ────────────
  if (!NON_TAB_ACTIONS.has(cmd.action)) {
    // Precedence: (1) an explicit --tab flag, (2) a tabId already in the
    // command JSON, (3) the session pin. No pin = no guessing: claim first.
    let tabId = opts.tab ?? (typeof cmd.tabId === "number" ? cmd.tabId : null);
    const explicit = tabId != null;
    if (tabId == null) {
      const existing = getSession(opts.session);
      if (!existing || existing.tabId == null) {
        out({ ok: false, error: "no tab for session " + opts.session + " — run claim first", hint: `node cli.js '{"action":"claim"}' --session ${opts.session}   (check the session name for typos)` });
        return;
      }
      tabId = existing.tabId;
    }
    if (cmd.action === "upload") {
      const paths = [].concat(cmd.path || cmd.paths || []).map(String);
      if (!paths.length) return out({ ok: false, error: "upload needs \"path\"", hint: `{"action":"upload","ref":"p1r3","path":"/abs/file.pdf"}` });
      const abs = paths.map((p) => path.resolve(p.replace(/^~(?=\/)/, os.homedir())));
      const missing = abs.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
      if (missing.length) return out({ ok: false, error: "file not found: " + missing.join(", "), hint: "give an absolute path to an existing file" });
      cmd = { ...cmd, path: abs.length === 1 ? abs[0] : abs };
      delete cmd.paths;
    }
    touchSession(opts.session);
    cmd = { ...cmd, tabId, ...(explicit ? {} : { session: opts.session }) };
    const res = await request(cmd, opts);
    if (!res.ok && /tab is gone|No tab with id/i.test(String(res.error || "")) && !explicit) {
      clearSession(opts.session);
      out({ ok: false, error: "the tab for session " + opts.session + " was closed — run claim to get a new one", hint: `node cli.js '{"action":"claim"}' --session ${opts.session}` });
      return;
    }
    return printResult(cmd, res, opts);
  }

  const res = await request(cmd, opts);
  return printResult(cmd, res, opts);
}

function printResult(cmd, res, opts) {
  // Remember where a navigate landed, so `guard` can pull the tab back.
  if (cmd.action === "navigate" && res.ok && cmd.tabId != null && cmd.session) {
    const existing = getSession(opts.session);
    if (existing) setSession(opts.session, { ...existing, url: cmd.url || null });
  }

  const value = res.ok ? res.value : null;
  // Persist screenshot payloads to disk and report the path.
  if (value && typeof value === "object" && value.dataUrl) {
    const format = value.format || "png";
    const ext = format === "jpeg" || format === "jpg" ? "jpg" : "png";
    const target = opts.out || path.join(shotsDir(), `${Date.now()}.${ext}`);
    const base64 = value.dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
    fs.writeFileSync(target, Buffer.from(base64, "base64"));
    out({ ok: true, file: target, width: value.width, height: value.height, source: value.source, format, hint: `read the text with: ./ocr ${target}` });
    return;
  }

  // snap: compact lines by default; "full":true keeps the JSON.
  if (cmd.action === "snap" && res.ok && value && Array.isArray(value.items) && !cmd.full) {
    out(formatSnap(value, { filter: cmd.filter }));
    return;
  }
  out(shapeReply(res));
}

// Action-specific patience: a wait or eval can legitimately take a while.
function timeoutFor(cmd) {
  if (cmd.action === "wait") return Math.min(Number(cmd.timeout) || 10000, 30000) + Math.min(Number(cmd.ms) || 0, 30000) + 8000;
  if (cmd.action === "navigate") return 30000;
  return 45000;
}

function request(cmd, opts) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const ws = new WebSocket(RELAY);
    let settled = false;
    let opened = false;
    const ms = timeoutFor(cmd);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(opened
        ? `no reply from Chrome within ${Math.round(ms / 1000)}s for "${cmd.action}" (the relay is up; the page or the extension is stuck — try {"action":"status"}, then snap)`
        : `cannot reach the Pilot relay at ${RELAY} — start it: node server.js (in the pilot folder)`));
    }, ms);

    ws.on("open", () => {
      opened = true;
      ws.send(JSON.stringify({ hello: "cli" }));
      // Auto-inject the session's pinned profile when no --profile was given,
      // so a `/bridge <profile>` claim keeps every later command in that profile.
      const profile = opts.profile || (getSession(opts.session || "default") || {}).profile || null;
      ws.send(JSON.stringify({ id, ...cmd, ...(profile ? { profile } : {}) }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === "status" && cmd.action === "status") {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: true, ...m }); ws.close(); }
        return;
      }
      if (m.id === id) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(m); ws.close(); }
      }
    });
    ws.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(/ECONNREFUSED/.test(String(e.message || e.code))
        ? `the Pilot relay is not running at ${RELAY} — start it: node server.js (in the pilot folder)`
        : String(e.message || e)));
    });
  });
}

(async () => {
  const opts = parseArgs(argv);
  if (opts.status) return run(null, opts);
  if (opts.sessions) return run(null, opts);
  if (!opts.json) {
    console.error("usage: node cli.js '<json command>' [--session NAME] [--profile NAME] [--tab ID] [--window ID | --new-window] [--out FILE] | --status | --sessions");
    console.error(`try: node cli.js '{"action":"help"}'`);
    process.exit(1);
  }
  let cmd;
  try {
    cmd = JSON.parse(opts.json);
  } catch {
    out({
      ok: false,
      error: "bad JSON: " + opts.json,
      hint: `single-quote the whole command, double-quote the keys. Example: node cli.js '{"action":"snap"}' --session myjob`,
    });
    process.exit(1);
  }
  if (!cmd || typeof cmd !== "object" || !cmd.action) {
    out({ ok: false, error: "command needs an \"action\" key", hint: `node cli.js '{"action":"help"}'` });
    process.exit(1);
  }
  await run(cmd, opts);
  process.exitCode = exitCode;
})().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  process.exit(1);
});
