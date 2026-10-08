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
//     same window. Pilot never activates, focuses or switches to a tab.
//   - Screenshots: active-tab captures use chrome.tabs.captureVisibleTab (no
//     infobar); background-tab captures use the Chrome DevTools Protocol, which
//     photographs any tab without touching focus. Images are downscaled in the
//     worker so they stay small enough for the harness to read.

importScripts("keys.js");

const DEFAULT_SETTINGS = {
  relayUrl: "ws://127.0.0.1:8756",
  profileName: "default",
  groupName: "Harness",
  groupColor: "red",
  visualFeedback: true,
  shotMaxWidth: 1280,
  shotFormat: "jpeg", // "jpeg" | "png"
  shotQuality: 0.82,
  screenshotMode: "auto", // "auto" (visible→CDP) | "cdp" | "visible"
  // Reconnect on browser/worker start without a popup click. On by default so
  // the harness keeps its hands after a reboot; turn it off in Options for a
  // strictly manual handshake.
  autoConnect: true,
  // Send clicks and keys through the Chrome debugger so the page receives
  // REAL trusted input (event.isTrusted === true), exactly like a human click.
  // Element targeting stays the same (clickN/clickText resolve the element,
  // scroll it into view, and the debugger clicks its center). Falls back to
  // synthetic events automatically when another debugger holds the tab or the
  // element is covered.
  trustedInput: true,
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
    const reply = (payload) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, ...payload }));
    };
    try {
      const value = await dispatchAction(msg, reply);
      if (value !== undefined) reply({ ok: true, value });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
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

// ── page library calls ──────────────────────────────────────────────────────
// page.js installs globalThis.__pilot in the tab's isolated world. Each call
// checks it is there (and from this worker's boot, so a reloaded extension
// never talks to a stale copy) and injects it on a miss.

const BOOT = Math.random().toString(36).slice(2);

async function pageCall(tabId, name, args) {
  const call = (boot, n, a) => {
    const P = globalThis.__pilot;
    if (!P || P.boot !== boot) return { __pilotMissing: true };
    return P[n](...a);
  };
  const exec = async (func, a) => {
    const rs = await chrome.scripting.executeScript({ target: { tabId }, func, args: a });
    const r = rs && rs[0];
    if (r && r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r ? r.result : undefined;
  };
  let res = await exec(call, [BOOT, name, args || []]);
  if (res && res.__pilotMissing) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
    await exec((boot) => { globalThis.__pilot.boot = boot; }, [BOOT]);
    res = await exec(call, [BOOT, name, args || []]);
  }
  return res;
}

// ── trusted input via the Chrome debugger ───────────────────────────────────
// Input.* events arrive as REAL user input (event.isTrusted === true; default
// actions run). The debugger attaches ONCE per tab and stays attached until
// the tab closes or Chrome detaches it, so the debugging infobar does not
// flash and shift the page between locating an element and clicking it.
// Focus emulation makes a background tab behave as if focused (focus events,
// :focus, document.hasFocus()) without touching the real tab or window focus.
// Pilot never calls tabs.update({active}) or windows.update({focused}).

const dbg = new Map(); // tabId -> Promise<void> (attached + focus emulation on)

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) dbg.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => dbg.delete(tabId));

function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve();
    });
  });
}

function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; resolve(); });
  });
}

function dbgSend(tabId, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(method + " timed out")), timeoutMs || 8000);
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      clearTimeout(timer);
      const e = chrome.runtime.lastError;
      if (e) reject(new Error(e.message)); else resolve(res);
    });
  });
}

function ensureDebugger(tabId) {
  if (dbg.has(tabId)) return dbg.get(tabId);
  const p = (async () => {
    try {
      await dbgAttach(tabId);
    } catch (e) {
      // A session from this extension's previous worker life can still hold
      // the tab: drop it and attach again. Another tool's debugger cannot be
      // detached from here, so the retry fails and the caller falls back.
      if (!/already attached/i.test(e.message)) throw e;
      await dbgDetach(tabId);
      await dbgAttach(tabId);
    }
    await dbgSend(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  })();
  dbg.set(tabId, p);
  p.catch(() => dbg.delete(tabId));
  return p;
}

async function cdp(tabId, method, params) {
  await ensureDebugger(tabId);
  return dbgSend(tabId, method, params);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mouse(tabId, type, x, y) {
  const p = { type, x, y, pointerType: "mouse", modifiers: 0 };
  if (type === "mouseMoved") Object.assign(p, { button: "none", buttons: 0 });
  else Object.assign(p, { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  return cdp(tabId, "Input.dispatchMouseEvent", p);
}

async function cdpKeyPress(tabId, events) {
  for (const ev of events) await cdp(tabId, "Input.dispatchKeyEvent", ev);
}

// ── Command dispatch ────────────────────────────────────────────────────────

// Actions that read or manage browser state without driving a page. They must
// not resolve a target tab: doing so grabs the user's ACTIVE tab and drags it
// into the Harness group as a side effect of a mere listing.
const METADATA_ACTIONS = new Set([
  "ping", "reload", "status", "tabs", "windows", "activeTab",
  "tabInfo", "closeTab", "harnessTab", "newHarnessTab", "gc",
]);

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

async function dispatchAction(msg, reply) {
  const action = msg.action;

  if (METADATA_ACTIONS.has(action)) {
    switch (action) {
      case "ping": return "v9";
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
      case "gc": {
        // Sweep leftover agent tabs: every about:blank tab in a Harness group
        // that no live session still pins, plus unfocused agent windows that
        // hold nothing but blank Harness tabs. Real pages and focused windows
        // are never touched.
        const keep = new Set(msg.keepTabIds || []);
        const removed = [];
        const ungrouped = [];
        const gcGroups = await chrome.tabGroups.query({ title: settings.groupName }).catch(() => []);
        for (const g of gcGroups) {
          const tabs = await chrome.tabs.query({ groupId: g.id });
          const survivors = [];
          for (const t of tabs || []) {
            const blank = !t.url || t.url.startsWith("about:blank");
            if (blank && !keep.has(t.id)) {
              await chrome.tabs.remove(t.id).catch(() => {});
              removed.push(t.id);
            } else {
              survivors.push(t.id);
            }
          }
          // Real pages the user (or a stray claim) dragged in: ungroup them so
          // the Harness group disappears instead of holding their tabs hostage.
          if (survivors.length) {
            await chrome.tabs.ungroup(survivors).catch(() => {});
            ungrouped.push(...survivors);
          }
        }
        const closedWindows = [];
        const gcWins = await chrome.windows.getAll({ populate: true });
        for (const w of gcWins) {
          if (w.focused || w.type !== "normal") continue;
          const gcTabs = w.tabs || [];
          const agentOnly = gcTabs.length > 0 && gcTabs.every(
            (t) => t.groupId !== -1 && (!t.url || t.url.startsWith("about:blank"))
          );
          if (agentOnly) {
            await chrome.windows.remove(w.id).catch(() => {});
            closedWindows.push(w.id);
          }
        }
        return { removedTabs: removed, ungrouped, closedWindows };
      }
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
        const groupId = await ensureGrouped(tab);
        // Attach the debugger now, once, so the first action does not shift
        // the page with a fresh infobar.
        if (settings.trustedInput) await ensureDebugger(tab.id).catch(() => {});
        return { tabId: tab.id, windowId: tab.windowId, groupId, url: tab.url || "" };
      }
    }
  }

  // Page actions need an explicit tab. Falling back to "the active tab" would
  // drive (and group) whatever the user is looking at.
  if (msg.tabId == null) {
    return { ok: false, error: "no tab: page actions need a tabId", hint: "use the CLI with --session NAME (it pins a tab), or pass --tab ID" };
  }
  const tab = await chrome.tabs.get(msg.tabId);
  await ensureGrouped(tab);
  const tabId = tab.id;
  const show = settings.visualFeedback;
  const trusted = settings.trustedInput;

  // Trusted click on a located element. The probe armed by locate tells us
  // whether the debugger's mouse events reached the page; only if none did
  // does the page fall back to a synthetic click, so nothing clicks twice.
  const clickSpec = async (spec) => {
    const loc = await pageCall(tabId, "locate", [spec, show]);
    if (!loc || loc.ok !== true) return loc;
    if (loc.covered || !trusted) {
      await pageCall(tabId, "clickTagged", []);
      const conf = (await pageCall(tabId, "confirmClick", [false]).catch(() => null)) || {};
      return { ok: true, ...loc.meta, ...pickChecked(conf), via: loc.covered ? "synthetic-covered" : "synthetic" };
    }
    let cdpError = null;
    try {
      // Hover first, then re-measure: hover-revealed controls can move when
      // they appear, so the click goes to the element's NEW center.
      await mouse(tabId, "mouseMoved", loc.x, loc.y);
      await sleep(60);
      const rem = await pageCall(tabId, "remeasure", []).catch(() => null);
      const x = rem && rem.x != null ? rem.x : loc.x;
      const y = rem && rem.y != null ? rem.y : loc.y;
      await mouse(tabId, "mousePressed", x, y);
      await mouse(tabId, "mouseReleased", x, y);
    } catch (e) {
      cdpError = String(e.message || e);
    }
    let conf;
    try { conf = (await pageCall(tabId, "confirmClick", [true])) || {}; } catch { conf = { landed: null }; /* page navigated: it landed */ }
    if (conf.fellBack) return { ok: true, ...loc.meta, ...pickChecked(conf), via: "synthetic-fallback", ...(cdpError ? { cdpError } : { note: "debugger click did not reach the page" }) };
    return { ok: true, ...loc.meta, ...pickChecked(conf), via: "cdp" };
  };

  // Run fn (which sends debugger input) with a probe armed for `kinds`.
  // Returns true if the page saw the events (or navigated away), false if
  // the input was dropped, or the error message if the debugger failed.
  const probed = async (kinds, fn) => {
    await pageCall(tabId, "armProbe", [kinds]);
    try { await fn(); } catch (e) {
      await pageCall(tabId, "readProbe", []).catch(() => null);
      return String(e.message || e);
    }
    const pr = await pageCall(tabId, "readProbe", []).catch(() => ({ landed: null }));
    return pr && pr.landed === false ? false : true;
  };

  // Type into a field: focus it in-page, select its content, then insert the
  // text through the debugger (Input.insertText, or one trusted key per char
  // for perKey). Verifies the value stuck; synthetic only if nothing landed.
  const typeInto = async (spec, text, perKey) => {
    const f = await pageCall(tabId, "focusField", [spec, true, show]);
    if (!f || f.ok !== true) return f;
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
    let chk = (await pageCall(tabId, "checkField", [text])) || {};
    if (via === "cdp" && chk.landed === false && !chk.stuck) via = null;
    if (!via) {
      await pageCall(tabId, "setTagged", [text, !!perKey]);
      chk = (await pageCall(tabId, "checkField", [text])) || {};
      via = trusted ? "synthetic-fallback" : "synthetic";
    }
    const out = { ok: !!chk.stuck, typed: text.length + " chars" + (perKey ? " (keystrokes)" : ""), into: f.into, ref: f.ref, via, valueNow: chk.valueNow };
    if (chk.landed) out.isTrusted = !!chk.trusted;
    if (cdpError) out.cdpError = cdpError;
    if (!chk.stuck) {
      out.error = "the field did not take the text (value is now '" + String(chk.valueNow || "") + "')";
      out.hint = perKey ? "the field may reject or reformat input; check form for errors" : "try typeKeys for masked or per-keystroke fields";
    }
    return out;
  };

  switch (action) {
    case "snap": return await pageCall(tabId, "snap", []);
    case "dialog": return await pageCall(tabId, "dialog", []);
    case "form": return await pageCall(tabId, "form", []);
    case "click": return await clickSpec(specOf(msg, false));
    case "clickText": return await clickSpec({ text: String(msg.text || ""), exact: !!msg.exact });
    case "clickN": return await clickSpec(msg.ref ? { ref: String(msg.ref) } : { n: Number(msg.n) });
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
      return { ...(await pageCall(tabId, "clickXY", [x, y, show])), via: "synthetic" };
    }
    case "hoverXY":
    case "hover": {
      let x = Number(msg.x), y = Number(msg.y), meta = {};
      if (action === "hover") {
        const spec = specOf(msg, true);
        if (!Object.keys(spec).length) return { ok: false, error: "hover needs {ref}, {n}, {text} or {sel}, or use hoverXY with {x},{y}" };
        const loc = await pageCall(tabId, "hoverLocate", [spec, show]);
        if (!loc || !loc.ok) return loc;
        ({ x, y } = loc);
        meta = loc;
      }
      if (trusted) {
        const landed = await probed(["pointermove", "mousemove"], () => mouse(tabId, "mouseMoved", x, y));
        if (landed === true) return { ok: true, ...meta, x, y, via: "cdp" };
      }
      const r = await pageCall(tabId, "hoverXY", [x, y, show]);
      return { ...r, ...meta, via: trusted ? "synthetic-fallback" : "synthetic" };
    }
    case "key": {
      const key = String(msg.key || "");
      const mods = { meta: !!msg.meta, shift: !!msg.shift, ctrl: !!msg.ctrl, alt: !!msg.alt };
      const evs = PilotKeys.keyEvents(key, mods);
      if (!evs) return { ok: false, error: "unknown key '" + key + "'", hint: "use a single character or a name like Enter, Tab, Escape, Backspace, Delete, ArrowDown, Home, End, PageDown, F5" };
      if (trusted) {
        const landed = await probed(["keydown"], () => cdpKeyPress(tabId, evs));
        if (landed === true) return { ok: true, key, ...(evs[0].commands ? { commands: evs[0].commands } : {}), via: "cdp" };
      }
      const r = await pageCall(tabId, "syntheticKey", [key, mods.meta, mods.shift]);
      return { ...r, via: trusted ? "synthetic-fallback" : "synthetic" };
    }
    case "type":
    case "replace": return await typeInto(specOf(msg, false), String(msg.text ?? ""), false);
    case "typeKeys": return await typeInto(specOf(msg, false), String(msg.text ?? ""), true);
    case "fill": {
      const spec = specOf(msg, false);
      if (!spec.ref && !spec.sel && spec.n == null) return { ok: false, error: "fill needs sel or ref", hint: "{\"action\":\"fill\",\"ref\":\"r3\",\"value\":\"...\"}" };
      const value = String(msg.value ?? "");
      const sel = await pageCall(tabId, "fillSelect", [spec, value]);
      if (!sel || !sel.notSelect) return sel;
      const kind = await pageCall(tabId, "targetKind", [spec]);
      if (kind && (kind.type === "checkbox" || kind.type === "radio")) {
        return { ok: false, error: "fill does not toggle a " + kind.type, hint: "click it instead: {\"action\":\"click\",\"ref\":\"...\"}" };
      }
      const r = await typeInto(spec, value, false);
      if (r && r.ok) r.filled = r.into;
      return r;
    }
    case "fillShadow": {
      const loc = await pageCall(tabId, "fillShadowLocate", [String(msg.match || "")]);
      if (!loc || !loc.ok) return loc;
      const spec = { ref: loc.ref };
      if (loc.tag === "select") return await pageCall(tabId, "fillSelect", [spec, String(msg.value ?? "")]);
      return await typeInto(spec, String(msg.value ?? ""), false);
    }
    case "tail": return await pageCall(tabId, "tail", []);
    case "read": return await pageCall(tabId, "read", [Number(msg.offset) || 0]);
    case "hrefs": return await pageCall(tabId, "hrefs", [String(msg.text || "")]);
    case "findText": return await pageCall(tabId, "findText", [String(msg.text || "")]);
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
      let onUpd;
      const loaded = new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpd); resolve(false); }, 15000);
        onUpd = (id, info) => {
          if (id === tabId && info.status === "complete") {
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpd);
            resolve(true);
          }
        };
        chrome.tabs.onUpdated.addListener(onUpd);
      });
      try {
        await chrome.tabs.update(tabId, { url: msg.url });
      } catch (e) {
        chrome.tabs.onUpdated.removeListener(onUpd);
        return { ok: false, error: "navigate failed: " + String(e.message || e), url: before };
      }
      const done = await loaded;
      const now = await chrome.tabs.get(tabId);
      const url = now.url || "";
      const sameAsAsked = stripHash(url) === stripHash(msg.url);
      if (url === before && !sameAsAsked) {
        return { ok: false, error: "navigation did not happen: the tab is still on " + before, url, title: now.title || "", loaded: done, hint: "check the URL (needs https://...); the page may also have blocked it" };
      }
      return { ok: true, url, title: now.title || "", loaded: done };
    }
    default:
      return reply({ ok: false, error: "unknown action '" + action + "'", hint: "run {\"action\":\"help\"} via the CLI for the command list" }) ?? undefined;
  }
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
// tab group (name/color from Options; default red "Harness"). The group is
// created in the tab's OWN window: without createProperties.windowId Chrome
// builds it in the last-focused window and moves the tab there, which is how
// a claimed agent-window tab ended up in the user's window (and the empty
// agent window closed).
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
// connect (intent). No intent → no reconnect → the handshake stays manual.
try {
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === "keepalive" && intent && (!ws || ws.readyState !== 1)) connect();
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
// survives reboots and extension reloads without a popup click. Options can
// turn it off for a strictly manual handshake via the popup's Connect.
loadSettings().then(() => {
  if (settings.autoConnect) {
    intent = true;
    connect();
  }
});
