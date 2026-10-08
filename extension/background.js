// Pilot — service worker.
//
// Holds the WS to the local relay and executes commands from the harness.
//
// Design notes:
//   - Auto-connect (default on): the worker dials the relay on start, so the
//     bridge survives reboots and reloads. Disconnect in the popup stops it
//     for the session; the Options page can turn auto-connect off entirely.
//   - Background-tab only. Reads run via chrome.scripting.executeScript and
//     input via the Chrome debugger, both of which work on inactive tabs, so
//     the harness drives a tab while the user works in another tab of the
//     same window. Pilot never activates, focuses or switches to a tab it
//     drives. Links that open a new tab are clicked with Cmd/Ctrl held so the
//     new tab opens in the background; if a page still opens one in the
//     foreground, the user's previous tab is put back at once.
//   - Every page call has a timeout, and JavaScript dialogs (alert, confirm,
//     prompt, beforeunload) are answered automatically through the debugger,
//     or by a page shim when the debugger is out, so a dialog can never hang
//     the bridge. Other extensions' frames are removed from driven tabs (they
//     make Chrome refuse the debugger) and a dropped debugger heals itself.
//   - Frames: page.js runs in every frame. Refs carry the document number
//     ("p4r12"), so a ref routes to the frame it came from, and a ref from a
//     page that has since navigated is refused instead of hitting a stranger.
//   - Cleanup: the worker remembers which tabs belong to which session (and
//     the tabs they opened). Release closes them; sessions idle past the
//     limit (Options, default 30 min) are released by an alarm; orphan Pilot
//     tabs are swept on start. A tab the user is viewing is never closed,
//     only ungrouped.
//   - Screenshots: active-tab captures use chrome.tabs.captureVisibleTab (no
//     infobar); background-tab captures use the Chrome DevTools Protocol, which
//     photographs any tab without touching focus.

importScripts("keys.js", "shared.js");

const VERSION = chrome.runtime.getManifest().version;

const DEFAULT_SETTINGS = {
  relayUrl: "ws://127.0.0.1:8756",
  profileName: "default",
  groupName: "Pilot",
  groupColor: "yellow",
  visualFeedback: true,
  shotMaxWidth: 1280,
  shotFormat: "jpeg", // "jpeg" | "png"
  shotQuality: 0.82,
  screenshotMode: "auto", // "auto" (visible→CDP) | "cdp" | "visible"
  // Reconnect on browser/worker start without a popup click.
  autoConnect: true,
  // Send clicks and keys through the Chrome debugger so the page receives
  // REAL trusted input (event.isTrusted === true). Falls back to synthetic
  // events automatically when another debugger holds the tab or the
  // element is covered.
  trustedInput: true,
  // Release a session's tabs after this many idle minutes (0 = never).
  idleReleaseMinutes: 30,
};

let settings = { ...DEFAULT_SETTINGS };
let ws = null;
let retry = null;
let keepaliveTimer = null;
let intent = false; // user asked to connect (not persisted across worker restarts)

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (got) => {
      settings = { ...DEFAULT_SETTINGS, ...got };
      // Migrate the old defaults ("Harness" / red) to "Pilot" / yellow.
      const fix = {};
      if (got.groupName === "Harness") fix.groupName = "Pilot";
      if (got.groupColor === "red") fix.groupColor = "yellow";
      if (Object.keys(fix).length) {
        Object.assign(settings, fix);
        chrome.storage.sync.set(fix);
      }
      resolve(settings);
    });
  });
}

function setState(state) {
  try { chrome.runtime.sendMessage({ type: "state", state }).catch(() => {}); } catch {}
}

function currentState() {
  return {
    connected: !!(ws && ws.readyState === 1),
    intent,
    profile: settings.profileName,
    relay: settings.relayUrl,
    version: VERSION,
  };
}

// ── WebSocket management ────────────────────────────────────────────────────

function connect() {
  if (retry) { clearTimeout(retry); retry = null; }
  try {
    ws = new WebSocket(settings.relayUrl);
  } catch { scheduleRetry(); return; }
  ws.onopen = () => {
    setState("connected");
    ws.send(JSON.stringify({ hello: "extension", profile: settings.profileName }));
    // MV3 suspends an idle worker after ~30s and kills the socket with it.
    // Chrome 116+ extends the worker's life on WebSocket TRAFFIC, so a small
    // application-level ping every 20s keeps the bridge up indefinitely.
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send('{"ka":1}');
    }, 20000);
  };
  ws.onclose = () => {
    setState("disconnected");
    ws = null;
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (intent) scheduleRetry();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || msg.id == null) return;
    const sock = ws;
    const reply = (payload) => {
      if (sock && sock.readyState === 1) sock.send(JSON.stringify({ id: msg.id, ...payload }));
    };
    const t0 = Date.now();
    try {
      let value = await dispatchAction(msg);
      value = await decorate(msg, value, t0);
      reply({ ok: true, value: value === undefined ? null : value });
    } catch (e) {
      const out = { ok: false, error: friendlyError(e) };
      if (msg.tabId != null) {
        await drainShim(msg.tabId).catch(() => {});
        const d = dialogsSince(msg.tabId, t0);
        if (d) out.dialog = d;
      }
      reply(out);
    }
  };
}

function scheduleRetry() {
  if (retry) return;
  retry = setTimeout(() => { retry = null; connect(); }, 3000);
}

function disconnect() {
  intent = false;
  if (retry) { clearTimeout(retry); retry = null; }
  try { if (ws) ws.close(); } catch {}
  ws = null;
  setState("disconnected");
}

// Turn Chrome's terse errors into what happened and what to do.
function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/No tab with id/i.test(m)) return "the tab is gone (closed) — " + m;
  if (/Cannot access contents of|cannot be scripted|chrome:\/\/|Cannot access a chrome/i.test(m)) {
    return "Pilot cannot script this page (a chrome:// page, the Web Store, or another extension's page): " + m;
  }
  if (/showing error page/i.test(m)) return "the tab is showing a browser error page (no connection or bad URL): " + m;
  return m;
}

// ── timeouts ────────────────────────────────────────────────────────────────

const PAGE_TIMEOUT_MS = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(what + " did not answer within " + Math.round(ms / 1000) + "s (the page is busy, frozen, or still loading)")), ms);
    }),
  ]);
}

// ── document numbers (ref epochs) ───────────────────────────────────────────
// Each document Pilot touches in a tab gets the next number for that tab.
// Kept in storage.local so neither a worker restart nor an extension reload
// ever hands out a number twice in the same tab (a reused number would make
// an old ref look valid on a new page).

let docSeq = {};
const docSeqReady = chrome.storage.local.get("docSeq").then((r) => { docSeq = (r && r.docSeq) || {}; }).catch(() => {});

async function nextDoc(tabId) {
  await docSeqReady;
  docSeq[tabId] = (docSeq[tabId] || 0) + 1;
  await chrome.storage.local.set({ docSeq }).catch(() => {});
  return docSeq[tabId];
}

// ── page library calls ──────────────────────────────────────────────────────
// page.js installs globalThis.__pilot in each frame's isolated world. Each
// call checks it is there (and from this worker's boot, so a reloaded
// extension never talks to a stale copy) and injects it on a miss.

const BOOT = Math.random().toString(36).slice(2);

function callFn(boot, n, a) {
  const P = globalThis.__pilot;
  if (!P || P.boot !== boot) return { __pilotMissing: true };
  try { return P[n](...a); } catch (e) { return { __pilotError: String((e && e.message) || e) }; }
}

function execScript(target, func, args) {
  // injectImmediately: do not wait for a slow frame to reach document_idle.
  return withTimeout(chrome.scripting.executeScript({ target, func, args: args || [], injectImmediately: true }), PAGE_TIMEOUT_MS, "the page");
}

async function injectInto(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  await withTimeout(chrome.scripting.executeScript({ target, files: ["page.js"], injectImmediately: true }), PAGE_TIMEOUT_MS, "the page");
  const cand = await nextDoc(tabId);
  await execScript(target, (b, c) => globalThis.__pilot.init(b, c), [BOOT, cand]);
}

async function pageCall(tabId, name, args, frameId) {
  const fid = frameId || 0;
  const target = { tabId, frameIds: [fid] };
  let [r] = await execScript(target, callFn, [BOOT, name, args || []]);
  let res = r ? r.result : undefined;
  if (res && res.__pilotMissing) {
    await injectInto(tabId, fid);
    [r] = await execScript(target, callFn, [BOOT, name, args || []]);
    res = r ? r.result : undefined;
  }
  if (res && res.__pilotError) throw new Error("page script error: " + res.__pilotError);
  return res;
}

// Run in every frame Pilot can reach. Frames that cannot be scripted are
// left out (see unreadableFrames); a frame that fails mid-call is skipped.
async function pageCallAll(tabId, name, args) {
  const rs = await execScript({ tabId, allFrames: true }, callFn, [BOOT, name, args || []]);
  const out = [];
  for (const r of rs || []) {
    let res = r.result;
    if (res && res.__pilotMissing) {
      try { res = await pageCall(tabId, name, args, r.frameId); } catch { continue; }
    }
    if (res && res.__pilotError) continue;
    out.push({ frameId: r.frameId, documentId: r.documentId, result: res });
  }
  return out;
}

// ── frames ──────────────────────────────────────────────────────────────────

async function frameList(tabId) {
  try { return (await chrome.webNavigation.getAllFrames({ tabId })) || []; } catch { return null; }
}

// Stable small numbers for frames in replies ("frame 1"), per tab.
const frameNums = new Map(); // tabId -> Map(frameId -> n)
function frameNum(tabId, frameId) {
  if (!frameId) return 0;
  let m = frameNums.get(tabId);
  if (!m) { m = new Map(); frameNums.set(tabId, m); }
  if (!m.has(frameId)) m.set(frameId, m.size + 1);
  return m.get(frameId);
}

// Where frame `frameId` sits in the top page's viewport. Same-origin frames
// measure themselves; cross-origin ones are found by their parent through a
// postMessage token. null when it cannot be worked out.
async function frameOffset(tabId, frameId, frames) {
  if (!frameId) return { x: 0, y: 0 };
  const self = await pageCall(tabId, "selfOffset", [], frameId).catch(() => null);
  if (self) return self;
  const list = frames || (await frameList(tabId)) || [];
  const info = list.find((f) => f.frameId === frameId);
  if (!info || info.parentFrameId == null || info.parentFrameId < 0) return null;
  const token = "pp" + Math.random().toString(36).slice(2);
  try {
    await pageCall(tabId, "probeListen", [token], info.parentFrameId);
    await pageCall(tabId, "probeSend", [token], frameId);
    let rel = null;
    for (let i = 0; i < 6 && !rel; i++) {
      await sleep(40);
      rel = await pageCall(tabId, "probeRead", [token], info.parentFrameId);
    }
    if (!rel) return null;
    const po = await frameOffset(tabId, info.parentFrameId, list);
    return po ? { x: po.x + rel.x, y: po.y + rel.y } : null;
  } catch { return null; }
}

// The main document's number (null if Pilot has not touched it yet).
async function mainDoc(tabId) {
  try {
    const [r] = await execScript({ tabId, frameIds: [0] }, () => {
      const de = document.documentElement;
      return de ? de.getAttribute("data-pilot-doc") : null;
    });
    return r ? r.result : null;
  } catch { return null; }
}

// Which frame holds document number `doc`? One cheap call across frames.
async function frameForDoc(tabId, doc) {
  const rs = await execScript({ tabId, allFrames: true }, () => {
    const de = document.documentElement;
    return de ? de.getAttribute("data-pilot-doc") : null;
  });
  const hit = (rs || []).find((r) => Number(r.result) === doc);
  return hit ? hit.frameId : null;
}

const STALE = { ok: false, stale: true, error: "page changed since that snap — snap again", hint: "refs are only valid on the page they came from; run {\"action\":\"snap\"} and use the new refs" };

// The refs of the last snap per tab, so {"n":3} means line 3 of that snap.
const lastSnap = new Map();

// Resolve a target spec to the frame it lives in. ref → its document's
// frame; n → the ref at that position in the last snap; sel/text → main
// frame first (others are tried on a miss by inFrames).
async function route(tabId, spec) {
  if (spec.n != null) {
    const refs = lastSnap.get(tabId);
    if (!refs) return { fail: { ok: false, error: "no snap to count from", hint: "run {\"action\":\"snap\"} first, then use the item's ref" } };
    const ref = refs[Number(spec.n)];
    if (!ref) return { fail: { ok: false, error: "no item " + spec.n + " (the last snap listed " + refs.length + ")", hint: "use a ref from the last snap" } };
    spec = { ref };
  }
  if (spec.ref) {
    const m = /^p(\d+)r\d+$/.exec(String(spec.ref).trim());
    if (!m) return { frameId: 0, spec }; // page.js explains what is wrong with it
    const fid = await frameForDoc(tabId, Number(m[1]));
    if (fid == null) return { fail: STALE };
    return { frameId: fid, spec, pinned: true };
  }
  return { frameId: 0, spec };
}

// Run fn in the routed frame; for sel/text misses in the main frame, try the
// other frames in turn and take the first that finds it.
async function inFrames(tabId, spec, fn) {
  const r = await route(tabId, spec);
  if (r.fail) return r.fail;
  const first = await fn(r.frameId, r.spec);
  if (r.pinned || !first || !first.notFound) return first;
  const frames = (await frameList(tabId)) || [];
  for (const f of frames) {
    if (f.frameId === 0) continue;
    const res = await fn(f.frameId, r.spec).catch(() => null);
    if (res && !res.notFound && !res.__frameSkip) {
      return { ...res, frame: frameNum(tabId, f.frameId) };
    }
  }
  return first;
}

// ── trusted input via the Chrome debugger ───────────────────────────────────
// Input.* events arrive as REAL user input (event.isTrusted === true; default
// actions run). The debugger attaches ONCE per tab and stays attached until
// the tab closes or Chrome detaches it, so the debugging infobar does not
// flash and shift the page between locating an element and clicking it.
// Focus emulation makes a background tab behave as if focused without
// touching the real tab or window focus. On attach Pilot also enables the
// Page (dialogs), Runtime + Log (console) and Network (requests) domains.

const dbg = new Map(); // tabId -> Promise<void>

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) {
    dbg.delete(source.tabId);
    // Chrome dropped the debugger (another extension's frame appeared, or
    // DevTools took over): dialogs now need the page shim until it is back.
    if (isDriven(source.tabId)) setShim(source.tabId, true).catch(() => {});
  }
});

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

function dbgDetach(tabId) {
  dbg.delete(tabId);
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
  });
}

function dbgSend(tabId, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(method + " timed out")), timeoutMs || PAGE_TIMEOUT_MS);
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      clearTimeout(timer);
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res);
    });
  });
}

function ensureDebugger(tabId) {
  if (dbg.has(tabId)) return dbg.get(tabId);
  const t = tabState.get(tabId);
  if (t && t.noCdp) return Promise.reject(new Error("debugger turned off for this tab (noDebugger test mode)"));
  const p = (async () => {
    try {
      await dbgAttach(tabId);
    } catch (e) {
      // A session from this extension's previous worker life can still hold
      // the tab: drop it and attach again. Another tool's debugger cannot be
      // detached from here, so the retry fails and the caller falls back.
      if (!/already attached/i.test(e.message)) throw e;
      await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
      await dbgAttach(tabId);
    }
    // Focus emulation is what makes trusted input land in a background tab:
    // without it the tab is only half usable, so a failure here detaches and
    // fails the attach instead of leaving a half-attached tab behind.
    try {
      await dbgSend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (e) {
      await new Promise((r) => chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; r(); }));
      throw e;
    }
    for (const [m, prm] of [
      ["Page.enable", {}], ["Runtime.enable", {}], ["Log.enable", {}], ["Network.enable", {}],
    ]) await dbgSend(tabId, m, prm).catch(() => {});
  })();
  dbg.set(tabId, p);
  p.catch(() => { if (dbg.get(tabId) === p) dbg.delete(tabId); });
  return p;
}

// Reset a tab's debugger state from scratch: clear what the worker believes,
// remove other extensions' frames (the usual reason Chrome refused), detach
// whatever is left, attach again and re-enable focus emulation.
async function healDebugger(tabId) {
  await guardFrames(tabId);
  await dbgDetach(tabId);
  await ensureDebugger(tabId);
}

// Attach (healing once on a refusal). Throws when the debugger stays out.
function cdpReady(tabId) {
  return PilotShared.withHeal(() => ensureDebugger(tabId), () => healDebugger(tabId));
}

// One debugger command; on a "not attached / refused" error the tab is
// healed and the command sent once more (see PilotShared.withHeal).
function cdp(tabId, method, params) {
  return PilotShared.withHeal(
    async () => { await ensureDebugger(tabId); return dbgSend(tabId, method, params); },
    () => healDebugger(tabId),
  );
}

// Keep other extensions' frames out of a driven tab's main document.
async function guardFrames(tabId) {
  const t = tabState.get(tabId);
  if (t && t.noCdp) return null;
  return pageCall(tabId, "guardExtFrames", [chrome.runtime.id], 0).catch(() => null);
}

// Chrome refuses the debugger on a tab that shows another extension's frame
// (a password manager's inline menu, for example). Say so plainly.
function explainCdp(msg) {
  const m = String(msg || "");
  if (/chrome-extension:\/\/|Cannot access a chrome-extension|different extension/i.test(m)) {
    return "Chrome blocked the debugger because another extension's frame (e.g. a password manager) is on this page; Pilot used simulated input instead";
  }
  if (/Another debugger|already attached/i.test(m)) return "another debugger (DevTools?) is attached to this tab; Pilot used simulated input instead";
  return null;
}

let MAC = true;
chrome.runtime.getPlatformInfo((p) => { MAC = !!p && p.os === "mac"; });

function mouse(tabId, type, x, y, modifiers, held) {
  const p = { type, x, y, pointerType: "mouse", modifiers: modifiers || 0 };
  // held: a move with the left button down (a drag); without it Chrome never
  // starts a drag, and nothing is intercepted.
  if (type === "mouseMoved") Object.assign(p, held ? { button: "left", buttons: 1 } : { button: "none", buttons: 0 });
  else Object.assign(p, { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  return cdp(tabId, "Input.dispatchMouseEvent", p);
}

async function cdpKeyPress(tabId, events) {
  for (const ev of events) await cdp(tabId, "Input.dispatchKeyEvent", ev);
}

// ── per-tab debugger events: dialogs, console, network, drags ──────────────

const tabState = new Map();
function st(tabId) {
  let s = tabState.get(tabId);
  if (!s) {
    s = { dialogs: [], lastDialog: null, policy: null, console: [], network: new Map(), drag: null, since: Date.now() };
    tabState.set(tabId, s);
  }
  return s;
}

function previewArgs(args) {
  return (args || []).map((a) => {
    if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
    return a.unserializableValue || a.description || a.type;
  }).join(" ").slice(0, 300);
}

chrome.debugger.onEvent.addListener((src, method, p) => {
  const tabId = src && src.tabId;
  if (tabId == null) return;
  const s = st(tabId);
  switch (method) {
    case "Page.javascriptDialogOpening": {
      const pol = s.policy || { accept: true };
      const accept = p.type === "beforeunload" ? true : pol.accept !== false;
      const params = { accept };
      if (p.type === "prompt") params.promptText = pol.promptText != null ? String(pol.promptText) : String(p.defaultPrompt || "");
      chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", params, () => { void chrome.runtime.lastError; });
      const rec = { type: p.type, message: String(p.message || "").slice(0, 500), accepted: accept, at: Date.now() };
      if (p.type === "prompt") rec.promptText = params.promptText;
      s.dialogs.push(rec);
      if (s.dialogs.length > 20) s.dialogs.shift();
      s.lastDialog = rec;
      if (pol.once) s.policy = null;
      break;
    }
    case "Runtime.consoleAPICalled":
      pushConsole(s, { level: p.type === "warning" ? "warn" : p.type, text: previewArgs(p.args) });
      break;
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      pushConsole(s, { level: "error", text: String((d.exception && d.exception.description) || d.text || "exception").slice(0, 300), url: d.url });
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry || {};
      pushConsole(s, { level: e.level === "warning" ? "warn" : e.level, text: String(e.text || "").slice(0, 300), source: e.source, url: e.url });
      break;
    }
    case "Network.requestWillBeSent": {
      const r = p.request || {};
      s.network.set(p.requestId, { method: r.method, url: String(r.url || "").slice(0, 200), type: p.type, at: Date.now() });
      if (s.network.size > 150) s.network.delete(s.network.keys().next().value);
      break;
    }
    case "Network.responseReceived": {
      const r = s.network.get(p.requestId);
      if (r && p.response) { r.status = p.response.status; r.mime = p.response.mimeType; }
      break;
    }
    case "Network.loadingFailed": {
      const r = s.network.get(p.requestId);
      if (r) r.failed = p.errorText || (p.canceled ? "canceled" : "failed");
      break;
    }
    case "Input.dragIntercepted":
      s.drag = p.data;
      break;
  }
});

function pushConsole(s, entry) {
  s.console.push({ ...entry, at: Date.now() });
  if (s.console.length > 200) s.console.shift();
}

// ── dialog shim (no debugger) ───────────────────────────────────────────────
// When the debugger is out (Chrome refused it, DevTools holds it, or the
// noDebugger test switch), a real alert/confirm/prompt would block the page
// and every call into it. In driven tabs only, Pilot then replaces
// window.alert/confirm/prompt in the page's MAIN world (every frame, again on
// every navigation) with non-blocking versions that follow the tab's dialog
// policy and record what they answered, and blocks beforeunload prompts. The
// debugger path (Page.javascriptDialogOpening) stays primary: once the
// debugger is back the shim is taken out and the real functions restored.

function shimTarget(tabId, frameId) {
  return frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
}

async function setShim(tabId, on, frameId) {
  const s = st(tabId);
  if (!on && !s.shim) return;
  if (frameId == null) s.shim = !!on;
  await withTimeout(chrome.scripting.executeScript({
    target: shimTarget(tabId, frameId), world: "MAIN", injectImmediately: true, func: PilotShared.dialogShim, args: [!!on, s.policy],
  }), PAGE_TIMEOUT_MS, "the page");
}

// Move what the shim answered into the tab's dialog log (for the reply).
async function drainShim(tabId) {
  const s = tabState.get(tabId);
  if (!s || !s.shim) return;
  let rs = [];
  try {
    rs = await withTimeout(chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", injectImmediately: true, func: PilotShared.drainShim }), 3000, "the page");
  } catch { return; }
  for (const r of rs || []) {
    for (const rec of r.result || []) {
      const d = { ...rec, via: "page-shim" };
      s.dialogs.push(d);
      if (s.dialogs.length > 20) s.dialogs.shift();
      s.lastDialog = d;
      if (s.policy && s.policy.once) s.policy = null;
    }
  }
}

// Each new document in a shimmed tab gets the shim as early as possible.
chrome.webNavigation.onCommitted.addListener((d) => {
  const s = tabState.get(d.tabId);
  if (s && s.shim && isDriven(d.tabId)) setShim(d.tabId, true, d.frameId).catch(() => {});
});

function dialogsSince(tabId, t0) {
  const s = tabState.get(tabId);
  if (!s) return null;
  const d = s.dialogs.filter((x) => x.at >= t0).map(({ at, ...rest }) => rest);
  if (!d.length) return null;
  return d.length === 1 ? d[0] : d;
}

// ── tabs Pilot owns, the tabs they open, and the user's active tab ─────────

// owned: { [tabId]: { session, lastUsed, parent? } } — kept in storage.local
// so cleanup still knows its tabs after a worker restart or extension reload.
let owned = {};
const ownedReady = chrome.storage.local.get("owned").then((r) => { owned = (r && r.owned) || {}; }).catch(() => {});
let ownedTimer = null;
function saveOwned() {
  if (ownedTimer) return;
  ownedTimer = setTimeout(() => { ownedTimer = null; chrome.storage.local.set({ owned }).catch(() => {}); }, 300);
}
function touchOwned(tabId, session) {
  const o = owned[tabId] || {};
  owned[tabId] = { ...o, session: session || o.session || null, lastUsed: Date.now() };
  if (o.parent != null && owned[o.parent]) owned[o.parent].lastUsed = Date.now();
  saveOwned();
}
const driven = new Set(); // tabs that got a page action in this worker life
const isDriven = (tabId) => driven.has(tabId) || owned[tabId] != null;

const pilotOpened = new Set();
const openedLog = []; // { opener, tabId, url, at }
const activeHist = new Map(); // windowId -> [current, previous]
const focusHist = [null, null]; // [current, previous] focused window ids

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (pilotOpened.has(tabId)) return;
  const h = activeHist.get(windowId) || [];
  if (h[0] !== tabId) activeHist.set(windowId, [tabId, h[0]]);
});
chrome.windows.onFocusChanged.addListener((wid) => {
  if (wid === chrome.windows.WINDOW_ID_NONE || wid === focusHist[0]) return;
  focusHist[1] = focusHist[0];
  focusHist[0] = wid;
});

// While an input action runs, a new tab may be its doing. Chrome does not
// always credit the driven tab as the opener (a Cmd+click in a background
// tab records the window's ACTIVE tab instead), so the action announces
// itself here; a link click also names the URL it expects to open.
let expecting = null; // { tabId, windowId, until, href }

// A tab opened from a driven tab (target=_blank link, window.open) belongs to
// Pilot: keep it in the background, group it with its opener, and report it
// in the reply of the action that opened it.
chrome.tabs.onCreated.addListener(async (tab) => {
  let opener = tab.openerTabId;
  if (opener == null || !isDriven(opener)) {
    const e = expecting;
    const u = tab.pendingUrl || tab.url || "";
    if (!e || Date.now() > e.until) return;
    if (e.href && u && stripHash(u) !== stripHash(e.href)) return;
    opener = e.tabId;
  }
  pilotOpened.add(tab.id);
  openedLog.push({ opener, tabId: tab.id, url: tab.pendingUrl || tab.url || "", at: Date.now() });
  if (openedLog.length > 50) openedLog.shift();
  await ownedReady;
  owned[tab.id] = { session: (owned[opener] && owned[opener].session) || null, parent: opener, lastUsed: Date.now() };
  saveOwned();
  if (tab.active) {
    const h = activeHist.get(tab.windowId) || [];
    const prev = h[0] === tab.id ? h[1] : h[0];
    const back = prev != null ? prev : opener;
    await chrome.tabs.update(back, { active: true }).catch(() => {});
  }
  let op = null;
  try { op = await chrome.tabs.get(opener); } catch {}
  if (op && op.windowId === tab.windowId) {
    if (op.groupId !== -1) await chrome.tabs.group({ tabIds: [tab.id], groupId: op.groupId }).catch(() => {});
    else await ensureGrouped(tab);
  } else {
    // A popup window: it cannot join a tab group. If it took focus, hand
    // focus back to the window the user had.
    await sleep(150);
    const w = await chrome.windows.get(tab.windowId).catch(() => null);
    if (w && w.focused) {
      const prevWin = focusHist[0] === tab.windowId ? focusHist[1] : focusHist[0];
      if (prevWin != null && prevWin !== tab.windowId) await chrome.windows.update(prevWin, { focused: true }).catch(() => {});
      else await chrome.windows.update(tab.windowId, { focused: false }).catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dbg.delete(tabId);
  tabState.delete(tabId);
  lastSnap.delete(tabId);
  frameNums.delete(tabId);
  driven.delete(tabId);
  pilotOpened.delete(tabId);
  if (owned[tabId]) { delete owned[tabId]; saveOwned(); }
  if (docSeq[tabId] != null) { delete docSeq[tabId]; chrome.storage.local.set({ docSeq }).catch(() => {}); }
});

async function openedSince(tabId, t0) {
  const hits = openedLog.filter((o) => o.opener === tabId && o.at >= t0);
  const out = [];
  for (const o of hits) {
    const t = await chrome.tabs.get(o.tabId).catch(() => null);
    out.push({ tabId: o.tabId, url: (t && (t.pendingUrl || t.url)) || o.url });
  }
  return out;
}

// Seed the active-tab history so the very first restore knows where to go.
chrome.tabs.query({ active: true }).then((tabs) => {
  for (const t of tabs) if (!activeHist.has(t.windowId)) activeHist.set(t.windowId, [t.id, null]);
}).catch(() => {});
chrome.windows.getLastFocused().then((w) => { if (w && focusHist[0] == null) focusHist[0] = w.id; }).catch(() => {});

// ── cleanup ─────────────────────────────────────────────────────────────────

const pilotTitles = () => [...new Set([settings.groupName, "Pilot", "Harness"])];

async function pilotGroupIds() {
  const gs = await chrome.tabGroups.query({}).catch(() => []);
  return new Set(gs.filter((g) => pilotTitles().includes(g.title)).map((g) => g.id));
}

// Close (or, if the user is viewing it, ungroup) one tab and forget it.
async function letGo(tabId, groups, out) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (owned[tabId]) { delete owned[tabId]; saveOwned(); }
  if (!t) return;
  await dbgDetach(tabId);
  const inPilot = groups.has(t.groupId);
  if (t.active) {
    if (inPilot) await chrome.tabs.ungroup(tabId).catch(() => {});
    out.ungrouped.push(tabId);
  } else if (!inPilot) {
    out.leftOpen.push(tabId);
  } else {
    await chrome.tabs.remove(tabId).catch(() => {});
    out.closed.push(tabId);
  }
}

// Release a session tab and every tab it opened.
async function releaseTab(tabId) {
  await ownedReady;
  const groups = await pilotGroupIds();
  const out = { closed: [], ungrouped: [], leftOpen: [] };
  const children = Object.entries(owned).filter(([, o]) => o && Number(o.parent) === tabId).map(([id]) => Number(id));
  for (const c of children) await letGo(c, groups, out);
  await letGo(tabId, groups, out);
  return { ok: true, ...out, ...(out.ungrouped.length ? { note: "the user is viewing a released tab, so it was left open and only taken out of the Pilot group" } : {}) };
}

async function sweep(apply, keep) {
  await ownedReady;
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  const plan = PilotShared.selectSweep({
    tabs: tabs.map((t) => ({ id: t.id, groupId: t.groupId, url: t.pendingUrl || t.url || "", active: t.active, lastAccessed: t.lastAccessed, discarded: t.discarded })),
    groups: groups.map((g) => ({ id: g.id, title: g.title })),
    titles: pilotTitles(),
    owned, keep: keep || [], now: Date.now(),
    idleMs: Math.max(0, Number(settings.idleReleaseMinutes) || 0) * 60000,
  });
  const info = new Map(tabs.map((t) => [t.id, t]));
  const show = (x) => ({ ...x, url: (info.get(x.id) || {}).url || "", title: ((info.get(x.id) || {}).title || "").slice(0, 60) });
  const result = { apply: !!apply, close: plan.close.map(show), ungroup: plan.ungroup.map(show), forget: plan.forget.map((x) => x.id) };
  if (!apply) return { ok: true, dryRun: true, ...result, hint: "nothing was changed; pass \"apply\":true to do it" };
  for (const f of plan.forget) { delete owned[f.id]; }
  // Children of closed tabs go with them.
  const closing = new Set(plan.close.map((x) => x.id));
  for (const [id, o] of Object.entries(owned)) {
    if (o && closing.has(Number(o.parent)) && !closing.has(Number(id))) {
      const t = info.get(Number(id));
      if (t && !t.active) { plan.close.push({ id: Number(id), reason: "opened by a released tab" }); closing.add(Number(id)); }
    }
  }
  for (const x of plan.ungroup) { await dbgDetach(x.id); await chrome.tabs.ungroup(x.id).catch(() => {}); delete owned[x.id]; }
  for (const x of plan.close) { await dbgDetach(x.id); await chrome.tabs.remove(x.id).catch(() => {}); delete owned[x.id]; }
  saveOwned();
  return { ok: true, ...result, close: plan.close.map(show) };
}

// ── Command dispatch ────────────────────────────────────────────────────────

const PAGE_ACTIONS = [
  "snap", "click", "clickText", "clickN", "clickXY", "hover", "hoverXY", "type", "replace", "typeKeys",
  "fill", "fillShadow", "upload", "drag", "key", "form", "dialog", "dialogPolicy", "findText", "read", "text",
  "tail", "hrefs", "scroll", "wait", "back", "forward", "navigate", "eval", "console", "network", "shot", "screenshot",
];
// Actions that read or manage browser state without driving a page. They must
// not resolve a target tab: doing so would drag the user's tab into the Pilot
// group as a side effect of a mere listing.
const METADATA_ACTIONS = new Set([
  "ping", "reload", "status", "tabs", "windows", "activeTab",
  "tabInfo", "closeTab", "harnessTab", "newHarnessTab", "gc", "cleanup", "releaseTab",
]);
const ALL_ACTIONS = [...METADATA_ACTIONS, ...PAGE_ACTIONS];

// Target spec shared by click/hover/type/fill: ref (stable) | n | sel | text.
// For type/fill, "text" is what to type, never a target.
function specOf(msg, textIsTarget) {
  const s = {};
  if (msg.ref != null && msg.ref !== "") s.ref = String(msg.ref);
  else if (msg.n != null && msg.n !== "") s.n = Number(msg.n);
  else if (msg.sel) s.sel = String(msg.sel);
  else if (textIsTarget && msg.text != null && msg.text !== "") { s.text = String(msg.text); s.exact = !!msg.exact; }
  return s;
}
const hasTarget = (s) => s.ref != null || s.n != null || s.sel != null || s.text != null;

// Input actions can start a navigation or open a tab. Give the page a moment
// to show which, wait for a navigation to finish, and say what happened.
const INPUT_ACTIONS = new Set(["click", "clickText", "clickN", "clickXY", "key", "type", "replace", "typeKeys", "fill", "drag"]);

async function settle(tabId, beforeUrl) {
  let t = null;
  for (let i = 0; i < 4; i++) {
    await sleep(100);
    t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === "loading" || (t.url || "") !== beforeUrl) break;
  }
  if (t && t.status === "loading") {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      await sleep(150);
      t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t || t.status === "complete") break;
    }
  }
  return t;
}

async function decorate(msg, value, t0) {
  const tabId = msg.tabId;
  if (tabId == null || METADATA_ACTIONS.has(msg.action) || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (INPUT_ACTIONS.has(msg.action) && msg.__beforeUrl != null) {
    const t = await settle(tabId, msg.__beforeUrl);
    // A form POST can reload the same URL: compare the document, not just the URL.
    const afterDoc = t ? await mainDoc(tabId) : null;
    const newDoc = msg.__beforeDoc != null && afterDoc !== msg.__beforeDoc;
    if (t && (newDoc || stripHash(t.url) !== stripHash(msg.__beforeUrl))) {
      value.navigated = true;
      value.url = t.url;
      if (!value.hint) value.hint = "the page changed — snap again before using refs";
    }
  }
  if (expecting && expecting.tabId === tabId) expecting.until = Math.min(expecting.until, Date.now() + 1000);
  await drainShim(tabId);
  const d = dialogsSince(tabId, t0);
  if (d) value.dialog = d;
  const opened = await openedSince(tabId, t0);
  if (opened.length) {
    value.opened = opened.length === 1 ? opened[0] : opened;
    if (!value.hint) value.hint = "a new tab opened in the background; drive it with --tab " + opened[0].tabId + " (your session tab is unchanged)";
  }
  return value;
}

async function dispatchAction(msg) {
  const action = msg.action;

  if (METADATA_ACTIONS.has(action)) {
    switch (action) {
      case "ping": return "pilot " + VERSION;
      case "reload": { setTimeout(() => chrome.runtime.reload(), 400); return "reloading"; }
      case "status": return currentState();
      case "tabs": {
        const tabs = await chrome.tabs.query({});
        return tabs.map((t) => ({ id: t.id, url: t.url || "", title: t.title || "", groupId: t.groupId, windowId: t.windowId, active: t.active }));
      }
      case "windows": {
        const wins = await chrome.windows.getAll();
        return wins.map((w) => ({ id: w.id, type: w.type, focused: w.focused, state: w.state }));
      }
      case "activeTab": {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return t ? { id: t.id, windowId: t.windowId, url: t.url || "", title: t.title || "" } : null;
      }
      case "tabInfo": {
        const t = await chrome.tabs.get(msg.tabId);
        return { id: t.id, windowId: t.windowId, url: t.url || "", title: t.title || "", groupId: t.groupId };
      }
      case "gc":
      case "cleanup":
        return await sweep(action === "gc" ? true : !!msg.apply, msg.keepTabIds);
      case "releaseTab":
        return await releaseTab(Number(msg.tabId));
      case "closeTab": {
        await dbgDetach(msg.tabId);
        await chrome.tabs.remove(msg.tabId);
        return { ok: true, closed: msg.tabId };
      }
      case "harnessTab": {
        const groups = await chrome.tabGroups.query({ title: settings.groupName }).catch(() => []);
        for (const g of groups) {
          const tabs = await chrome.tabs.query({ groupId: g.id });
          const candidate = (tabs || []).find((t) => !(t.url || "").includes("127.0.0.1:3080"));
          if (candidate) return { tabId: candidate.id, windowId: candidate.windowId, url: candidate.url || "", title: candidate.title || "" };
        }
        return null;
      }
      case "newHarnessTab": {
        let tab;
        if (msg.newWindow) {
          const win = await chrome.windows.create({ url: msg.url || "about:blank", focused: false });
          tab = win.tabs && win.tabs[0];
          if (!tab) [tab] = await chrome.tabs.query({ windowId: win.id });
        } else {
          const createProps = { url: msg.url || "about:blank", active: false };
          if (msg.windowId != null) createProps.windowId = msg.windowId;
          tab = await chrome.tabs.create(createProps);
        }
        await ownedReady;
        touchOwned(tab.id, msg.session);
        driven.add(tab.id);
        const groupId = await ensureGrouped(tab);
        // Attach the debugger now, once, so the first action does not shift
        // the page with a fresh infobar.
        if (settings.trustedInput) await ensureDebugger(tab.id).catch(() => {});
        return { tabId: tab.id, windowId: tab.windowId, groupId, url: tab.url || "" };
      }
    }
  }

  if (!PAGE_ACTIONS.includes(action)) {
    return { ok: false, error: "unknown action '" + action + "'", hint: "run {\"action\":\"help\"} for the list", actions: ALL_ACTIONS };
  }

  // Page actions need an explicit tab. Falling back to "the active tab" would
  // drive (and group) whatever the user is looking at.
  if (msg.tabId == null) {
    return { ok: false, error: "no tab: page actions need a tabId", hint: "use the CLI with --session NAME (after claim), or pass --tab ID" };
  }
  const tab = await chrome.tabs.get(msg.tabId);
  await ensureGrouped(tab);
  const tabId = tab.id;
  driven.add(tabId);
  await ownedReady;
  if (msg.session || owned[tabId]) touchOwned(tabId, msg.session);
  msg.__beforeUrl = tab.url || "";
  if (INPUT_ACTIONS.has(action)) {
    expecting = { tabId, windowId: tab.windowId, until: Date.now() + 15000, href: null };
    msg.__beforeDoc = await mainDoc(tabId);
  }
  const show = settings.visualFeedback;
  let trusted = settings.trustedInput;
  let cdpNote = null;
  // Test switch: "noDebugger":true runs this tab without the debugger (as if
  // Chrome refused it) until "noDebugger":false.
  if (msg.noDebugger != null) {
    st(tabId).noCdp = !!msg.noDebugger;
    if (msg.noDebugger) await dbgDetach(tabId);
  }
  // Attach first: dialog handling and console/network capture need it.
  // If Chrome refuses, input falls back to simulated events and dialogs are
  // answered by a small page shim instead.
  await guardFrames(tabId);
  let attached = true;
  try { await cdpReady(tabId); } catch (e) {
    attached = false;
    cdpNote = explainCdp(e.message) || ("debugger unavailable: " + e.message);
    trusted = false;
  }
  await setShim(tabId, !attached).catch(() => {});
  const withNote = (r) => (cdpNote && r && typeof r === "object" && !Array.isArray(r) && /^synthetic/.test(String(r.via || "")) ? { ...r, cdpNote } : r);

  // Trusted click on a located element. The probe armed by locate tells us
  // whether the debugger's mouse events reached the page; only if none did
  // does the page fall back to a synthetic click, so nothing clicks twice.
  // Links that open a new tab are clicked with Cmd (Ctrl off macOS) held, so
  // Chrome opens the tab in the background.
  const clickIn = async (frameId, spec) => {
    const loc = await pageCall(tabId, "locate", [spec, show], frameId);
    if (!loc || loc.ok !== true) return loc;
    const off = await frameOffset(tabId, frameId);
    const frameMeta = frameId ? { frame: frameNum(tabId, frameId) } : {};
    if (loc.covered || !trusted || !off) {
      await pageCall(tabId, "clickTagged", [], frameId);
      const conf = (await pageCall(tabId, "confirmClick", [false], frameId).catch(() => null)) || {};
      return { ok: true, ...loc.meta, ...frameMeta, ...pickChecked(conf), via: loc.covered ? "synthetic-covered" : !off ? "synthetic-frame" : "synthetic" };
    }
    const mods = loc.newTab ? (MAC ? 4 : 2) : 0;
    if (loc.newTab && expecting && expecting.tabId === tabId) expecting.href = loc.href || null;
    let cdpError = null;
    try {
      // Hover first, then re-measure: hover-revealed controls can move when
      // they appear, so the click goes to the element's NEW center.
      await mouse(tabId, "mouseMoved", loc.x + off.x, loc.y + off.y);
      await sleep(60);
      const rem = await pageCall(tabId, "remeasure", [], frameId).catch(() => null);
      const x = (rem && rem.x != null ? rem.x : loc.x) + off.x;
      const y = (rem && rem.y != null ? rem.y : loc.y) + off.y;
      await mouse(tabId, "mousePressed", x, y, mods);
      await mouse(tabId, "mouseReleased", x, y, mods);
    } catch (e) {
      cdpError = String(e.message || e);
    }
    if (loc.newTab) {
      for (let i = 0; i < 6 && !openedLog.some((o) => o.opener === tabId && o.at >= Date.now() - 1500); i++) await sleep(100);
    }
    let conf;
    try { conf = (await pageCall(tabId, "confirmClick", [true], frameId)) || {}; } catch { conf = { landed: null }; /* page navigated: it landed */ }
    const extra = loc.newTab ? { newTab: true } : {};
    if (conf.fellBack) return { ok: true, ...loc.meta, ...frameMeta, ...extra, ...pickChecked(conf), via: "synthetic-fallback", ...(cdpError ? { cdpError, ...(explainCdp(cdpError) ? { cdpNote: explainCdp(cdpError) } : {}) } : { note: "debugger click did not reach the page" }) };
    return { ok: true, ...loc.meta, ...frameMeta, ...extra, ...pickChecked(conf), via: "cdp" };
  };
  const clickSpec = (spec) => inFrames(tabId, spec, clickIn);

  // Run fn (which sends debugger input) with a probe armed for `kinds`.
  // Returns true if the page saw the events (or navigated away), false if
  // the input was dropped, or the error message if the debugger failed.
  const probed = async (kinds, fn, frameId) => {
    await pageCall(tabId, "armProbe", [kinds], frameId);
    try { await fn(); } catch (e) {
      await pageCall(tabId, "readProbe", [], frameId).catch(() => null);
      return String(e.message || e);
    }
    const pr = await pageCall(tabId, "readProbe", [], frameId).catch(() => ({ landed: null }));
    return pr && pr.landed === false ? false : true;
  };

  // Type into a field: focus it in-page, select its content, then insert the
  // text through the debugger (Input.insertText, or one trusted key per char
  // for perKey). Verifies the value stuck; synthetic only if nothing landed.
  // Typed inputs (number, date, time, color, range, ...) are validated and
  // set with the native setter instead.
  const typeIn = (text, perKey) => async (frameId, spec) => {
    const f = await pageCall(tabId, "focusField", [spec, true, show], frameId);
    if (!f || f.ok !== true) return f;
    const frameMeta = frameId ? { frame: frameNum(tabId, frameId) } : {};
    if (f.native) {
      const r = await pageCall(tabId, "setNative", [text], frameId);
      return { ...r, into: f.into, ref: f.ref, type: f.type, ...frameMeta };
    }
    let via = null;
    let cdpError = null;
    if (trusted) {
      try {
        if (perKey) {
          for (const ch of text) {
            const evs = PilotKeys.keyEvents(ch === "\n" ? "Enter" : ch, {});
            if (evs) await cdpKeyPress(tabId, evs);
            else await cdp(tabId, "Input.insertText", { text: ch });
          }
        } else if (text === "") {
          await cdpKeyPress(tabId, PilotKeys.keyEvents("Delete", {}));
        } else {
          await cdp(tabId, "Input.insertText", { text });
        }
        via = "cdp";
      } catch (e) {
        cdpError = String(e.message || e);
      }
    }
    let chk = (await pageCall(tabId, "checkField", [text], frameId)) || {};
    if (via === "cdp" && chk.landed === false && !chk.stuck) via = null;
    if (!via) {
      await pageCall(tabId, "setTagged", [text, !!perKey], frameId);
      chk = (await pageCall(tabId, "checkField", [text], frameId)) || {};
      via = trusted ? "synthetic-fallback" : "synthetic";
    }
    const out = { ok: !!chk.stuck, typed: text.length + " chars" + (perKey ? " (keystrokes)" : ""), into: f.into, ref: f.ref, ...frameMeta, via, valueNow: chk.valueNow };
    if (chk.landed) out.isTrusted = !!chk.trusted;
    if (cdpError) { out.cdpError = cdpError; const n = explainCdp(cdpError); if (n) out.cdpNote = n; }
    if (!chk.stuck) {
      out.error = "the field did not take the text (value is now '" + String(chk.valueNow || "") + "')";
      out.hint = perKey ? "the field may reject or reformat input; check form for errors" : "try typeKeys for masked or per-keystroke fields";
    }
    return out;
  };
  const typeInto = (spec, text, perKey) => inFrames(tabId, spec, typeIn(text, perKey));

  // type/replace/typeKeys/fill need the text: a missing text must never
  // silently clear the field. "" clears only with "clear":true.
  const needText = (key) => {
    const v = msg[key];
    if (v == null) return { ok: false, error: action + " needs \"" + key + "\"", hint: "{\"action\":\"" + action + "\",\"ref\":\"p1r3\",\"" + key + "\":\"...\"}; to empty a field send \"" + key + "\":\"\" with \"clear\":true" };
    if (String(v) === "" && msg.clear !== true) return { ok: false, error: "empty " + key + " would clear the field", hint: "add \"clear\":true if you really want to empty it" };
    return null;
  };

  switch (action) {
    case "snap": return await snapAll(tabId, msg);
    case "dialog": {
      await drainShim(tabId);
      const text = await pageCall(tabId, "dialog", []).catch(() => null);
      const s = tabState.get(tabId);
      return { ok: true, text, jsDialog: (s && s.lastDialog) || null, ...(s && s.policy ? { policy: s.policy } : {}) };
    }
    case "dialogPolicy": {
      const s = st(tabId);
      s.policy = { accept: msg.accept !== false, ...(msg.promptText != null ? { promptText: String(msg.promptText) } : {}), ...(msg.once ? { once: true } : {}) };
      if (s.shim) await setShim(tabId, true).catch(() => {});
      return { ok: true, policy: s.policy, lastDialog: s.lastDialog, note: "alert/confirm/prompt dialogs in this tab are now " + (s.policy.accept ? "accepted" : "dismissed") + (s.policy.once ? " (next dialog only)" : "") + "; beforeunload is always accepted" };
    }
    case "form": {
      const rs = await pageCallAll(tabId, "form", []);
      const main = rs.find((r) => r.frameId === 0);
      const out = (main && main.result) || { ok: false, error: "could not read the page" };
      for (const r of rs) {
        if (r.frameId === 0 || !r.result || !r.result.fields || !r.result.fields.length) continue;
        const n = frameNum(tabId, r.frameId);
        out.fields = (out.fields || []).concat(r.result.fields.map((f) => ({ ...f, frame: n })));
        out.errors = (out.errors || []).concat((r.result.errors || []).map((e) => ({ ...e, frame: n })));
        if (r.result.missing) out.missing = (out.missing || []).concat(r.result.missing);
      }
      return out;
    }
    case "click": {
      const spec = specOf(msg, false);
      if (!hasTarget(spec)) return { ok: false, error: "click needs ref, sel or n", hint: "{\"action\":\"click\",\"ref\":\"p1r3\"}, or clickText with {\"text\":\"Save\"}" };
      return withNote(await clickSpec(spec));
    }
    case "clickText": return withNote(await clickSpec({ text: String(msg.text || ""), exact: !!msg.exact }));
    case "clickN": return withNote(await clickSpec(msg.ref ? { ref: String(msg.ref) } : { n: Number(msg.n) }));
    case "clickXY": {
      const x = Number(msg.x), y = Number(msg.y);
      if (trusted) {
        const landed = await probed(["pointerdown", "mousedown", "click"], async () => {
          await mouse(tabId, "mouseMoved", x, y);
          await mouse(tabId, "mousePressed", x, y);
          await mouse(tabId, "mouseReleased", x, y);
        });
        if (landed === true) return { ok: true, x, y, via: "cdp" };
        const r = await pageCall(tabId, "clickXY", [x, y, show]);
        return { ...r, via: "synthetic-fallback", ...(typeof landed === "string" ? { cdpError: landed } : {}) };
      }
      return withNote({ ...(await pageCall(tabId, "clickXY", [x, y, show])), via: "synthetic" });
    }
    case "hoverXY":
    case "hover": {
      let x = Number(msg.x), y = Number(msg.y), meta = {}, frameId = 0;
      if (action === "hover") {
        const spec = specOf(msg, true);
        if (!hasTarget(spec)) return { ok: false, error: "hover needs {ref}, {text} or {sel}, or use hoverXY with {x},{y}" };
        const loc = await inFrames(tabId, spec, async (fid, sp) => {
          const r = await pageCall(tabId, "hoverLocate", [sp, show], fid);
          return r && r.ok ? { ...r, __fid: fid } : r;
        });
        if (!loc || !loc.ok) return loc;
        frameId = loc.__fid;
        const off = (await frameOffset(tabId, frameId)) || { x: 0, y: 0 };
        x = loc.x + off.x; y = loc.y + off.y;
        meta = { hovered: loc.hovered, ref: loc.ref, ...(frameId ? { frame: frameNum(tabId, frameId) } : {}) };
      }
      if (trusted) {
        const landed = await probed(["pointermove", "mousemove"], () => mouse(tabId, "mouseMoved", x, y), frameId);
        if (landed === true) return { ok: true, ...meta, x, y, via: "cdp" };
      }
      const r = frameId ? { ok: true } : await pageCall(tabId, "hoverXY", [x, y, show]);
      return withNote({ ...r, ...meta, via: trusted ? "synthetic-fallback" : "synthetic" });
    }
    case "key": {
      const key = String(msg.key || "");
      const mods = { meta: !!msg.meta, shift: !!msg.shift, ctrl: !!msg.ctrl, alt: !!msg.alt };
      const evs = PilotKeys.keyEvents(key, mods);
      if (!evs) return { ok: false, error: "unknown key '" + key + "'", hint: "use a single character or a name like Enter, Tab, Escape, Backspace, Delete, ArrowDown, Home, End, PageDown, F5" };
      let cdpError = null;
      if (trusted) {
        const landed = await probed(["keydown"], () => cdpKeyPress(tabId, evs));
        if (landed === true) return { ok: true, key, ...(evs[0].commands ? { commands: evs[0].commands } : {}), via: "cdp" };
        if (typeof landed === "string") cdpError = landed;
      }
      const r = await pageCall(tabId, "syntheticKey", [key, mods.meta, mods.shift]);
      const out = withNote({ ...r, via: trusted ? "synthetic-fallback" : "synthetic" });
      if (cdpError) { out.cdpError = cdpError; const n = explainCdp(cdpError); if (n) out.cdpNote = n; }
      return out;
    }
    case "type":
    case "replace":
    case "typeKeys": {
      const bad = needText("text");
      if (bad) return bad;
      return withNote(await typeInto(specOf(msg, false), String(msg.text), action === "typeKeys"));
    }
    case "fill": {
      const spec = specOf(msg, false);
      if (!hasTarget(spec)) return { ok: false, error: "fill needs ref or sel", hint: "{\"action\":\"fill\",\"ref\":\"p1r3\",\"value\":\"...\"}" };
      const bad = needText("value");
      if (bad) return bad;
      const value = String(msg.value);
      return withNote(await inFrames(tabId, spec, async (fid, sp) => {
        const sel = await pageCall(tabId, "fillSelect", [sp, value], fid);
        if (!sel || !sel.notSelect) return sel;
        const kind = await pageCall(tabId, "targetKind", [sp], fid);
        if (kind && (kind.type === "checkbox" || kind.type === "radio")) {
          return { ok: false, error: "fill does not toggle a " + kind.type, hint: "click it instead: {\"action\":\"click\",\"ref\":\"...\"}" };
        }
        if (kind && kind.type === "file") return { ok: false, error: "that is a file input", hint: "use {\"action\":\"upload\",\"ref\":\"...\",\"path\":\"/abs/file\"}" };
        const r = await typeIn(value, false)(fid, sp);
        if (r && r.ok) r.filled = r.into;
        return r;
      }));
    }
    case "fillShadow": {
      const value = String(msg.value ?? "");
      return await inFrames(tabId, { sel: "__shadow__" }, async (fid) => {
        const loc = await pageCall(tabId, "fillShadowLocate", [String(msg.match || "")], fid);
        if (!loc || !loc.ok) return loc;
        const spec = { ref: loc.ref };
        if (loc.tag === "select") return await pageCall(tabId, "fillSelect", [spec, value], fid);
        return await typeIn(value, false)(fid, spec);
      });
    }
    case "upload": return await upload(tabId, msg, trusted);
    case "drag": return await drag(tabId, msg, trusted, show);
    case "tail": return await pageCall(tabId, "tail", []);
    case "read": {
      const r = await pageCall(tabId, "read", [Number(msg.offset) || 0]);
      if (!Number(msg.offset)) {
        const frames = (await pageCallAll(tabId, "read", [0]).catch(() => [])).filter((x) => x.frameId !== 0 && x.result && x.result.text && x.result.text.trim());
        if (frames.length) r.frames = frames.map((x) => ({ frame: frameNum(tabId, x.frameId), text: x.result.text.slice(0, 3000) }));
      }
      return r;
    }
    case "text": return await pageCall(tabId, "mainText", [Number(msg.offset) || 0]);
    case "hrefs": return await pageCall(tabId, "hrefs", [String(msg.text || "")]);
    case "findText": {
      const rs = await pageCallAll(tabId, "findText", [String(msg.text || "")]);
      const out = [];
      for (const r of rs.sort((a, b) => a.frameId - b.frameId)) {
        if (!Array.isArray(r.result) || !r.result.length) continue;
        const off = r.frameId ? await frameOffset(tabId, r.frameId) : { x: 0, y: 0 };
        for (const hit of r.result) {
          const h = { ...hit };
          if (r.frameId) { h.frame = frameNum(tabId, r.frameId); if (off) { h.x += off.x; h.y += off.y; } }
          out.push(h);
        }
      }
      return { ok: out.length > 0, matches: out.slice(0, 10), ...(out.length ? { hint: "click a match with {\"action\":\"click\",\"ref\":\"" + out[0].ref + "\"}" } : { error: "text '" + String(msg.text || "") + "' is not on the page", hint: "try a shorter piece of it, or wait for it with {\"action\":\"wait\",\"text\":\"...\"}" }) };
    }
    case "scroll": {
      const spec = specOf(msg, false);
      if (hasTarget(spec)) return await inFrames(tabId, spec, (fid, sp) => pageCall(tabId, "scroll", [sp], fid));
      if (msg.to != null && msg.to !== "top" && msg.to !== "bottom") return { ok: false, error: "to must be \"top\" or \"bottom\"" };
      return await pageCall(tabId, "scroll", [null, msg.dy, msg.to]);
    }
    case "wait": return await waitFor(tabId, msg);
    case "back":
    case "forward": return await history(tabId, tab, action);
    case "eval": return await evalJs(tabId, msg);
    case "console": {
      const s = st(tabId);
      let list = s.console;
      if (msg.level) list = list.filter((e) => e.level === msg.level);
      const n = Math.min(Number(msg.limit) || 30, 200);
      return { ok: true, since: new Date(s.since).toISOString().slice(11, 19), count: list.length, entries: list.slice(-n).map(({ at, ...e }) => e) };
    }
    case "network": {
      const s = st(tabId);
      let list = [...s.network.values()];
      if (msg.failed) list = list.filter((r) => r.failed || (r.status >= 400));
      const n = Math.min(Number(msg.limit) || 30, 150);
      return { ok: true, since: new Date(s.since).toISOString().slice(11, 19), count: list.length, requests: list.slice(-n).map(({ at, ...r }) => r) };
    }
    case "shot":
    case "screenshot":
      return await takeScreenshot(tab, msg);
    case "navigate": {
      // Wait for the load to finish so the very next snap sees the new page,
      // not the old one mid-teardown. 15s cap; a slow page returns loaded:false.
      const before = tab.url || "";
      if (!/^[a-z][a-z0-9+.-]*:/i.test(String(msg.url || ""))) {
        return { ok: false, error: "navigate needs an absolute URL, got '" + String(msg.url || "") + "'", url: before, hint: "include the scheme: https://example.com" };
      }
      const loaded = waitComplete(tabId, 15000);
      try {
        await chrome.tabs.update(tabId, { url: msg.url });
      } catch (e) {
        return { ok: false, error: "navigate failed: " + String(e.message || e), url: before };
      }
      const done = await loaded;
      const now = await chrome.tabs.get(tabId);
      const url = now.url || "";
      const sameAsAsked = stripHash(url) === stripHash(msg.url);
      if (url === before && !sameAsAsked) {
        return { ok: false, error: "navigation did not happen: the tab is still on " + before, url, title: now.title || "", loaded: done, hint: "check the URL (needs https://...); the page may also have blocked it" };
      }
      return { ok: true, url, title: now.title || "", loaded: done, hint: "snap to see the page" };
    }
  }
  return { ok: false, error: "unknown action '" + action + "'", hint: "run {\"action\":\"help\"} for the list", actions: ALL_ACTIONS };
}

function waitComplete(tabId, ms) {
  let onUpd;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, ms);
    onUpd = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpd);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpd);
  });
}

// ── snap across frames ──────────────────────────────────────────────────────

async function snapAll(tabId, msg) {
  const rs = await pageCallAll(tabId, "snap", [{ cap: 400 }]);
  const main = rs.find((r) => r.frameId === 0);
  if (!main || !main.result) throw new Error("could not read the page (it may still be loading — try wait or snap again)");
  const m = main.result;
  const frames = await frameList(tabId);
  const parts = [{ frame: 0, result: m }];
  const frameInfo = [];
  for (const r of rs.sort((a, b) => a.frameId - b.frameId)) {
    if (r.frameId === 0 || !r.result || !(r.result.vw > 0 && r.result.vh > 0)) continue;
    const n = frameNum(tabId, r.frameId);
    const off = await frameOffset(tabId, r.frameId, frames);
    const onScreen = !!off && off.y < m.vh && off.x < m.vw && off.y + r.result.vh > 0 && off.x + r.result.vw > 0;
    parts.push({ frame: n, offset: off, onScreen, result: r.result });
    frameInfo.push({ frame: n, url: String(r.result.url || "").slice(0, 120), items: (r.result.items || []).length, ...(off ? {} : { note: "position unknown; clicks use simulated input" }) });
  }
  const cap = Math.min(Math.max(Number(msg.limit) || 150, 1), 400);
  const merged = PilotShared.mergeSnapItems(parts, cap);
  lastSnap.set(tabId, merged.items.map((i) => i.ref));
  const items = merged.items.map((it, n) => ({ n, ...it }));
  let unreadable = [];
  if (frames) {
    const seen = new Set(rs.map((r) => r.frameId));
    unreadable = frames.filter((f) => !seen.has(f.frameId) && f.url && !/^about:(blank|srcdoc)/.test(f.url))
      .map((f) => String(f.url).slice(0, 120));
  }
  let text = m.text || "";
  for (const p of parts.slice(1)) {
    const t = (p.result.text || "").trim();
    if (t) text += "\n[frame " + p.frame + "] " + t.slice(0, 600);
  }
  return {
    doc: m.doc, title: m.title, url: m.url,
    text: text.slice(0, 3600),
    items,
    total: merged.total,
    ...(merged.truncated ? { truncated: true, hint: merged.left + " more items not listed (off screen or past the limit) — scroll, use findText, or pass \"limit\":300" } : {}),
    ...(m.dialog ? { dialog: m.dialog } : {}),
    ...(frameInfo.length ? { frames: frameInfo } : {}),
    ...(unreadable.length ? { unreadableFrames: unreadable, unreadableNote: "Pilot could not read these frames (another extension's frame, a sandboxed frame, or a browser page)" } : {}),
  };
}

// ── wait / history / eval ───────────────────────────────────────────────────

async function waitFor(tabId, msg) {
  const timeout = Math.min(Math.max(Number(msg.timeout) || 10000, 100), 30000);
  if (msg.ms != null && msg.text == null && msg.sel == null && msg.gone == null) {
    const ms = Math.min(Math.max(Number(msg.ms) || 0, 0), 30000);
    await sleep(ms);
    return { ok: true, waited: ms };
  }
  const w = {};
  if (msg.sel) w.sel = String(msg.sel);
  if (msg.text != null) w.text = String(msg.text);
  if (msg.gone != null) w.gone = msg.gone === true ? true : String(msg.gone);
  if (w.gone === true && !w.sel) return { ok: false, error: "\"gone\":true needs \"sel\"", hint: "{\"action\":\"wait\",\"sel\":\"#spinner\",\"gone\":true} or {\"action\":\"wait\",\"gone\":\"Loading\"}" };
  if (w.sel == null && w.text == null && w.gone == null) return { ok: false, error: "wait needs text, sel, gone or ms", hint: "{\"action\":\"wait\",\"text\":\"Hello\"}" };
  const goneMode = w.gone != null;
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeout) {
    try {
      const rs = await pageCallAll(tabId, "waitCheck", [w]);
      const bad = rs.find((r) => r.result && r.result.ok === false);
      if (bad) return bad.result;
      const mets = rs.filter((r) => r.result).map((r) => r.result.met);
      const met = mets.length && (goneMode ? mets.every(Boolean) : mets.some(Boolean));
      if (met) return { ok: true, waited: Date.now() - t0 };
    } catch (e) { lastErr = String(e.message || e); }
    await sleep(250);
  }
  const what = w.sel ? "selector " + w.sel + (goneMode ? " to disappear" : "") : goneMode ? "'" + w.gone + "' to disappear" : "text '" + w.text + "'";
  return { ok: false, error: "timed out after " + Math.round(timeout / 1000) + "s waiting for " + what, hint: "snap to see the page; pass \"timeout\":20000 for slow pages", ...(lastErr ? { lastError: lastErr } : {}) };
}

async function history(tabId, tab, action) {
  const before = tab.url || "";
  const done = waitComplete(tabId, 10000);
  try {
    if (action === "back") await chrome.tabs.goBack(tabId); else await chrome.tabs.goForward(tabId);
  } catch (e) {
    return { ok: false, error: "cannot go " + action + ": " + String(e.message || e), url: before };
  }
  await Promise.race([done, sleep(1500)]);
  const now = await chrome.tabs.get(tabId);
  if ((now.url || "") === before && now.status === "complete") {
    return { ok: false, error: "nothing to go " + action + " to (still on " + before + ")", url: before };
  }
  if (now.status === "loading") await done;
  const t = await chrome.tabs.get(tabId);
  return { ok: true, url: t.url || "", title: t.title || "", hint: "snap to see the page" };
}

async function evalJs(tabId, msg) {
  const js = String(msg.js || "");
  if (!js.trim()) return { ok: false, error: "eval needs \"js\"", hint: "{\"action\":\"eval\",\"js\":\"document.title\"}" };
  const timeout = Math.min(Math.max(Number(msg.timeout) || 5000, 100), 20000);
  const run = (expr) => dbgSend(tabId, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, timeout, userGesture: false, replMode: true }, timeout + 1000);
  let res;
  let attached = false;
  try {
    await cdpReady(tabId);
    attached = true;
    // REPL mode swallows a top-level `return` and answers {}. Compile the
    // script plainly first; if `return` makes it invalid, run it as a body.
    let code = js;
    if (/\breturn\b/.test(js)) {
      const c = await dbgSend(tabId, "Runtime.compileScript", { expression: js, sourceURL: "", persistScript: false }, timeout + 1000).catch(() => null);
      // REPL mode does not unwrap a returned promise, so await it in the script.
      if (c && c.exceptionDetails) code = "await (async () => {\n" + js + "\n})()";
    }
    res = await run(code);
  } catch (e) {
    // The script may already have run when the debugger dropped mid-way:
    // never run it a second time in the page.
    if (attached) return { ok: false, error: "eval failed: " + String(e.message || e), hint: "the debugger dropped while the script ran; it may have run — check the page before running it again" };
    // No debugger (another extension's frame, DevTools): run it in the page's
    // main world instead. The page's CSP may forbid eval there.
    try {
      const [r] = await withTimeout(chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, world: "MAIN", injectImmediately: true, args: [js],
        func: async (code) => {
          try {
            let v;
            try { v = (0, eval)(code); } catch (err) {
              if (!/return/.test(String(err))) throw err;
              v = (0, eval)("(async () => {\n" + code + "\n})()");
            }
            v = await v;
            return { v: v === undefined ? null : JSON.parse(JSON.stringify(v)) };
          } catch (err) { return { e: String((err && err.message) || err) }; }
        },
      }), timeout + 1000, "the page");
      const res2 = r && r.result;
      if (res2 && res2.e) return { ok: false, error: "script threw: " + res2.e, ...(/unsafe-eval|Content Security Policy/i.test(res2.e) ? { hint: "this page's security policy blocks eval and the debugger is unavailable (" + (explainCdp(e.message) || e.message) + ")" } : {}) };
      return { ok: true, value: res2 ? res2.v : null, via: "main-world", note: explainCdp(e.message) || "debugger unavailable" };
    } catch (e2) {
      return { ok: false, error: "eval failed: " + String(e2.message || e2), hint: explainCdp(e.message) || "keep scripts short; they run in the page's main frame with a " + timeout / 1000 + "s limit" };
    }
  }
  const ex = res && res.exceptionDetails;
  if (ex) return { ok: false, error: "script threw: " + String((ex.exception && ex.exception.description) || ex.text).slice(0, 500) };
  const r = (res && res.result) || {};
  let value = r.value !== undefined ? r.value : r.type === "undefined" ? null : (r.unserializableValue || r.description || null);
  let s = JSON.stringify(value);
  const truncated = s && s.length > 8000;
  if (truncated) value = s.slice(0, 8000);
  return { ok: true, value, type: r.subtype || r.type, ...(truncated ? { truncated: true } : {}) };
}

// ── upload + drag ───────────────────────────────────────────────────────────

async function upload(tabId, msg, trusted) {
  const paths = [].concat(msg.path || msg.paths || []).map(String).filter(Boolean);
  if (!paths.length) return { ok: false, error: "upload needs \"path\" (an absolute file path)", hint: "{\"action\":\"upload\",\"ref\":\"p1r3\",\"path\":\"/Users/me/file.pdf\"}" };
  if (paths.some((p) => !p.startsWith("/"))) return { ok: false, error: "upload paths must be absolute: " + paths.join(", ") };
  const spec = specOf(msg, false);
  if (!hasTarget(spec)) spec.sel = "input[type=file]";
  const token = "u" + Math.random().toString(36).slice(2);
  return await inFrames(tabId, spec, async (fid, sp) => {
    const loc = await pageCall(tabId, "fileLocate", [sp, token], fid);
    if (!loc || !loc.ok) return loc;
    if (paths.length > 1 && !loc.multiple) return { ok: false, error: "this file input takes one file", hint: "send one path" };
    try {
      await cdp(tabId, "DOM.getDocument", { depth: -1, pierce: true });
      const sr = await cdp(tabId, "DOM.performSearch", { query: '[data-pilot-u="' + token + '"]', includeUserAgentShadowDOM: true });
      let nodeIds = [];
      if (sr.resultCount > 0) nodeIds = (await cdp(tabId, "DOM.getSearchResults", { searchId: sr.searchId, fromIndex: 0, toIndex: sr.resultCount })).nodeIds || [];
      cdp(tabId, "DOM.discardSearchResults", { searchId: sr.searchId }).catch(() => {});
      if (!nodeIds.length) return { ok: false, error: "the debugger cannot reach this file input (it is probably in a cross-origin frame)", hint: "open the frame's URL in the tab and upload there" };
      await cdp(tabId, "DOM.setFileInputFiles", { files: paths, nodeId: nodeIds[0] });
    } catch (e) {
      return { ok: false, error: "upload failed: " + String(e.message || e), hint: explainCdp(e.message) || (trusted ? "check the path exists and is readable" : "upload needs the debugger; turn trusted input on in Options") };
    }
    const chk = await pageCall(tabId, "fileCheck", [token], fid);
    return { ok: !!(chk && chk.files && chk.files.length), into: loc.name, ref: loc.ref, files: (chk && chk.files) || [], via: "cdp-setFileInputFiles", ...(fid ? { frame: frameNum(tabId, fid) } : {}) };
  });
}

async function drag(tabId, msg, trusted, show) {
  const asSpec = (v, key) => {
    if (v && typeof v === "object") return specOf(v, true);
    if (v == null || v === "") return null;
    const s = String(v);
    return /^p\d+r\d+$/.test(s) || /^r\d+$/.test(s) ? { ref: s } : { text: s };
  };
  const from = asSpec(msg.from), to = asSpec(msg.to);
  if (!from || !to) return { ok: false, error: "drag needs from and to (refs)", hint: "{\"action\":\"drag\",\"from\":\"p1r3\",\"to\":\"p1r7\"}" };
  const rf = await route(tabId, from);
  if (rf.fail) return { ...rf.fail, which: "from" };
  const rt = await route(tabId, to);
  if (rt.fail) return { ...rt.fail, which: "to" };
  if (rf.pinned && rt.pinned && rf.frameId !== rt.frameId) return { ok: false, error: "from and to are in different frames", hint: "Pilot can only drag within one frame" };
  const fid = rf.pinned ? rf.frameId : rt.frameId;
  const loc = await pageCall(tabId, "dragLocate", [rf.spec, rt.spec, show], fid);
  if (!loc || !loc.ok) return loc;
  const off = (await frameOffset(tabId, fid)) || { x: 0, y: 0 };
  const a = { x: loc.from.x + off.x, y: loc.from.y + off.y };
  const b = { x: loc.to.x + off.x, y: loc.to.y + off.y };
  const base = { ok: true, from: loc.from.name || loc.from.ref, to: loc.to.name || loc.to.ref };
  let cdpError = null, seen = [];
  if (trusted) {
    const s = st(tabId);
    s.drag = null;
    try {
      await cdp(tabId, "Input.setInterceptDrags", { enabled: true });
      await mouse(tabId, "mouseMoved", a.x, a.y);
      await mouse(tabId, "mousePressed", a.x, a.y);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        await mouse(tabId, "mouseMoved", Math.round(a.x + (b.x - a.x) * i / steps), Math.round(a.y + (b.y - a.y) * i / steps), 0, true);
        await sleep(20);
      }
      for (let i = 0; i < 5 && !s.drag; i++) await sleep(40);
      if (s.drag) {
        const data = s.drag;
        for (const type of ["dragEnter", "dragOver", "drop"]) {
          await cdp(tabId, "Input.dispatchDragEvent", { type, x: b.x, y: b.y, data, modifiers: 0 });
        }
      }
      await mouse(tabId, "mouseReleased", b.x, b.y);
    } catch (e) { cdpError = String(e.message || e); }
    await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
    const pr = (await pageCall(tabId, "dragDone", [], fid).catch(() => null)) || {};
    seen = pr.seen || [];
    if (seen.includes("drop")) return { ...base, via: "cdp-html5-drag" };
    if (!loc.html5 && !seen.includes("dragstart") && seen.includes("mouseup") && !cdpError) {
      return { ...base, via: "cdp-mouse", note: "no HTML5 drop event fired; the page uses mouse-driven dragging — snap to check it moved" };
    }
    // Re-tag for the synthetic path (dragDone cleared the marks).
    const again = await pageCall(tabId, "dragLocate", [rf.spec, rt.spec, false], fid);
    if (!again || !again.ok) return again;
  }
  const r = await pageCall(tabId, "dragSynthetic", [], fid);
  if (!r || !r.ok) return r;
  return { ...base, via: "synthetic-dragevent", ...(cdpError ? { cdpError } : {}), note: "sent HTML5 drag events with a DataTransfer; snap to check it moved" };
}

function pickChecked(conf) {
  const out = {};
  if (conf && conf.checkedNow !== undefined) out.checkedNow = conf.checkedNow;
  if (conf && conf.landed) out.isTrusted = !!conf.trusted;
  return out;
}

function stripHash(u) {
  return String(u || "").replace(/#.*$/, "").replace(/\/$/, "");
}

// ── Screenshots ─────────────────────────────────────────────────────────────

// Small screenshot the harness can actually read. Returns a downscaled data
// URL plus its pixel size. The calling side (CLI) writes it to disk.
async function takeScreenshot(tab, msg) {
  const format = String(msg.format || settings.shotFormat) === "png" ? "png" : "jpeg";
  const quality = Number(msg.quality ?? settings.shotQuality);
  const maxWidth = Number(msg.maxWidth ?? settings.shotMaxWidth) || 0;

  let dataUrl;
  const mode = String(msg.mode || settings.screenshotMode);
  const isActive = await tabIsActive(tab);

  if (mode === "visible" || (mode === "auto" && isActive)) {
    const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (format === "png" && (!maxWidth || maxWidth >= 4096)) {
      const dims = await measureDataUrl(png);
      return { dataUrl: png, width: dims.width, height: dims.height, format: "png", source: "visible" };
    }
    dataUrl = png; // downscale below
  } else {
    // CDP photographs any tab without touching focus.
    dataUrl = await cdpScreenshot(tab.id, "png");
  }

  const down = await downscaleDataUrl(dataUrl, maxWidth, format, quality);
  return { ...down, source: isActive ? "visible" : "cdp" };
}

function tabIsActive(tab) {
  return chrome.tabs.query({ active: true, windowId: tab.windowId }).then((t) => t[0] && t[0].id === tab.id);
}

async function cdpScreenshot(tabId, format) {
  const res = await cdp(tabId, "Page.captureScreenshot", { format });
  if (!res || !res.data) throw new Error("no screenshot data");
  return `data:image/png;base64,${res.data}`;
}

async function measureDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const { width, height } = bmp;
  bmp.close();
  return { width, height };
}

async function downscaleDataUrl(dataUrl, maxWidth, format, quality) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = maxWidth > 0 && bmp.width > maxWidth ? maxWidth / bmp.width : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality });
  return { dataUrl: await blobToDataUrl(out), width: w, height: h, format };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

// ── Tab helpers ─────────────────────────────────────────────────────────────

// Mark the tab the harness is driving so it is obvious on screen: a colored
// tab group (name/color from Options; default yellow "Pilot"). The group is
// created in the tab's OWN window: without createProperties.windowId Chrome
// builds it in the last-focused window and moves the tab there.
async function ensureGrouped(tab) {
  if (tab.groupId !== -1) return tab.groupId;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: settings.groupName, color: settings.groupColor }).catch(() => {});
    return groupId;
  } catch (e) {
    return -1;
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

// Keepalive: MV3 service workers sleep and take the WebSocket with them. The
// alarm wakes the worker; we only reconnect if the user already asked to
// connect (intent). The sweep alarm releases idle sessions and orphan tabs.
try {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.create("pilot-sweep", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive" && intent && (!ws || ws.readyState !== 1)) connect();
    if (a.name === "pilot-sweep") sweep(true, []).catch(() => {});
  });
} catch (e) {
  console.error("pilot alarms unavailable:", e);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "connect") {
    intent = true;
    try { if (ws) ws.close(); } catch {}
    connect();
    sendResponse({ state: "connecting", ...currentState() });
  } else if (msg && msg.type === "disconnect") {
    disconnect();
    sendResponse(currentState());
  } else if (msg && msg.type === "state-query") {
    sendResponse(currentState());
  } else if (msg && msg.type === "settings-updated") {
    loadSettings().then(() => {
      // Relay URL or profile changed while connected → re-handshake.
      if (intent && ws && ws.readyState === 1) {
        try { ws.close(); } catch {}
        connect();
      }
      sendResponse(currentState());
    });
    return true; // async
  }
  return true;
});

// autoConnect (default on): the worker connects on start, so the bridge
// survives reboots and extension reloads without a popup click. On start the
// worker also sweeps orphan Pilot tabs left behind by a crash or a reload.
loadSettings().then(() => {
  if (settings.autoConnect) {
    intent = true;
    connect();
  }
  setTimeout(() => { sweep(true, []).catch(() => {}); }, 5000);
});
