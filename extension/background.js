// Pilot — service worker.
//
// Holds the WS to the local relay and executes commands from the harness.
//
// Design notes:
//   - No auto-connect. The user clicks Connect in the popup; that click is the
//     handshake and the only way this profile appears on the relay. Disconnect
//     closes the socket and nothing reconnects until Connect is clicked again.
//   - Background-tab friendly. Commands run via chrome.scripting.executeScript,
//     which works on inactive tabs, so the harness can drive a tab while the
//     user works elsewhere. We only bring the tab forward when the
//     "focusOnAction" setting is on (off by default).
//   - Screenshots: active-tab captures use chrome.tabs.captureVisibleTab (no
//     infobar); background-tab captures use the Chrome DevTools Protocol, which
//     photographs any tab without touching focus. Images are downscaled in the
//     worker so they stay small enough for the harness to read.

const DEFAULT_SETTINGS = {
  relayUrl: "ws://127.0.0.1:8756",
  harnessUrl: "http://127.0.0.1:3080",
  profileName: "default",
  focusOnAction: false,
  autoStartRelay: true,
  groupName: "Harness",
  groupColor: "red",
  shotMaxWidth: 1280,
  shotFormat: "jpeg", // "jpeg" | "png"
  shotQuality: 0.82,
  screenshotMode: "auto", // "auto" (visible→CDP) | "cdp" | "visible"
};

let settings = { ...DEFAULT_SETTINGS };
let ws = null;
let retry = null;
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
    groupName: settings.groupName || "Harness",
    groupColor: settings.groupColor || "red",
  };
}

// ── page functions (run in the tab's isolated world; no eval, CSP-safe) ─────
// ONE self-contained function per injection: Chrome serializes the function
// body into the page but NOT the helpers it references, so every helper is
// inlined. Visual feedback: a soft glow around the tab edge + a cursor arrow
// at the last interaction point.
function actFunc(mode, a, b, c) {
  const base = "cb-bridge-";
  const ensureArm = () => {
    let cursor = document.getElementById(base + "cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = base + "cursor";
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;z-index:2147483647;display:none;";
      cursor.innerHTML =
        '<svg width="22" height="22" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 3px rgba(0,0,0,0.8))"><path d="M4 2l16 9.5-6.8 1.6L9 20.5z" fill="#fff" stroke="#c00" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    let glow = document.getElementById(base + "glow");
    if (!glow) {
      glow = document.createElement("div");
      glow.id = base + "glow";
      glow.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483646;box-sizing:border-box;" +
        "border:3px solid rgba(255,110,110,0.55);" +
        "box-shadow:inset 0 0 48px 14px rgba(255,90,90,0.26), 0 0 40px 8px rgba(255,90,90,0.35);";
      document.documentElement.appendChild(glow);
    }
    return cursor;
  };
  const pointAt = (el) => {
    const cursor = ensureArm();
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
    cursor.style.display = "block";
    return { x, y };
  };
  const fireClick = (el, x, y) => {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    for (const type of ["mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, opts));
    }
  };

  if (mode === "hrefs") {
    return [...document.querySelectorAll("a[href]")]
      .map((x) => ({ text: (x.innerText || "").trim().slice(0, 40), href: x.getAttribute("href") }))
      .filter((x) => x.href.includes("plugin_asdk") || x.text === a)
      .slice(0, 10);
  }
  if (mode === "clickXY") {
    const el = document.elementFromPoint(a, b);
    if (!el) return "no element at " + a + "," + b;
    const p = pointAt(el);
    fireClick(el, p.x, p.y);
    return "clicked @ " + a + "," + b + " -> " + el.tagName + " " + (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30);
  }
  if (mode === "tail") {
    const text = (document.body && document.body.innerText || "");
    return text.slice(-3000);
  }
  if (mode === "key") {
    const target = document.activeElement || document.body;
    const opts = { key: a, code: a, bubbles: true, cancelable: true };
    if (b) opts.metaKey = true;
    if (c) opts.shiftKey = true;
    if (a === "Enter" || a === " " || a === "Tab") opts.keyCode = a === "Enter" ? 13 : a === "Tab" ? 9 : 32;
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return "key: " + a + (b ? " (meta)" : "") + (c ? " (shift)" : "") + " on " + target.tagName;
  }
  if (mode === "click") {
    const el = a && document.querySelector(a);
    if (!el) return "NOT FOUND: " + a;
    const p = pointAt(el);
    fireClick(el, p.x, p.y);
    return "clicked: " + a + " @ " + p.x + "," + p.y;
  }
  if (mode === "clickText") {
    const candidates = [...document.querySelectorAll(
      "button, a, [role=button], [role=checkbox], [role=link], [role=tab], [onclick], span, div, li")];
    const el = candidates.find((x) => {
      const t = (x.innerText || "").trim();
      const tc = (x.textContent || "").trim();
      return c ? (t === a || tc === a) : (t.startsWith(a) || tc.startsWith(a));
    });
    if (!el) return "NOT FOUND text: " + a + (c ? " (exact)" : "");
    const p = pointAt(el);
    fireClick(el, p.x, p.y);
    return "clicked text: " + (c ? "[" + a + "]" : a) + " @ " + p.x + "," + p.y;
  }
  if (mode === "type" || mode === "replace") {
    const all = [...document.querySelectorAll('[contenteditable="true"], textarea, input[type=text]')];
    const el = (a && document.querySelector(a)) || all.find((e) => e.offsetParent !== null);
    if (!el) return "NOT FOUND composer (" + all.length + " candidates)";
    pointAt(el);
    el.focus();
    let done;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, b);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      done = "input";
    } else {
      if (mode === "replace") document.execCommand("selectAll", false, null);
      done = "execCommand=" + document.execCommand("insertText", false, b);
    }
    return JSON.stringify({ tag: el.tagName, done, len: b.length, editable: el.getAttribute("contenteditable") });
  }
  return "unknown mode " + mode;
}

function snapFunc() {
  const out = { title: document.title, url: location.href };
  out.text = (document.body && document.body.innerText || "").slice(0, 3000);
  out.items = [...document.querySelectorAll("button, a, input, textarea, select, [role=dialog], [role=checkbox], label")]
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 70),
        icon: el.tagName === "BUTTON" && !(el.innerText || "").trim() ? "icon-btn" : "",
        visible: r.width > 0 && r.height > 0,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        w: Math.round(r.width),
      };
    })
    .filter((i) => i.visible && (i.text || i.icon))
    .slice(0, 120);
  return out;
}
function findTextFunc(text) {
  const out = [];
  for (const el of document.querySelectorAll("button, a, span, div, li, [role=button], [role=link], [role=tab]")) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.x < 400) continue; // skip the sidebar/left rail
    const t = (el.innerText || "").trim();
    if (t.startsWith(text) && el.children.length <= 4) {
      out.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), text: t.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y) });
    }
    if (out.length >= 10) break;
  }
  return out;
}
function fillFunc(sel, value) {
  const el = sel && document.querySelector(sel);
  if (!el) return "NOT FOUND: " + sel;
  const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  return "filled: " + sel;
}
function dialogFunc() {
  const d = document.querySelector("[role=dialog]");
  return d ? d.innerText.slice(0, 2000) : null;
}
function formFunc() {
  const scope = document.querySelector("[role=dialog]") || document;
  return {
    inputs: [...scope.querySelectorAll("input")].map((i) => ({
      name: i.name, type: i.type, placeholder: i.placeholder || null,
      value: (i.value || "").slice(0, 40), checked: i.checked,
    })),
    selects: [...scope.querySelectorAll("select")].map((s) => ({
      value: s.value,
      options: [...s.options].map((o) => o.innerText.trim() + "=" + o.value).join(" / "),
    })),
    radios: [...scope.querySelectorAll("[role=radiogroup], input[type=radio]")].map((r) => ({
      text: (r.innerText || r.getAttribute("aria-label") || r.value || "").trim().slice(0, 40),
      checked: r.checked,
    })),
    errors: (scope.innerText.match(/[Ee]rror[^\n]{0,100}|required[^\n]{0,100}|must[^\n]{0,100}/g) || []).slice(0, 5),
  };
}
// Deep page snapshot: metadata, headings, links, forms, images, text.
function pageFunc() {
  const meta = {};
  for (const m of document.querySelectorAll("meta")) {
    const key = m.name || m.getAttribute("property") || "";
    if (key && !meta[key]) meta[key] = (m.content || "").slice(0, 300);
  }
  const head = (el) => (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100);
  return {
    title: document.title,
    url: location.href,
    meta,
    lang: document.documentElement.lang || "",
    headings: [...document.querySelectorAll("h1,h2,h3")].map(head).filter(Boolean).slice(0, 40),
    links: [...document.querySelectorAll("a[href]")]
      .map((a) => ({ text: head(a), href: a.href }))
      .filter((l) => l.href && !l.href.startsWith("javascript:"))
      .slice(0, 120),
    forms: [...document.querySelectorAll("form")].map((f) => ({
      action: f.action || "", method: f.method || "get",
      fields: [...f.querySelectorAll("input,select,textarea,button")].map((i) => ({
        tag: i.tagName.toLowerCase(), name: i.name || i.id || "", type: i.type || "",
        placeholder: i.placeholder || "", value: (i.value || "").slice(0, 40),
        text: head(i),
      })).slice(0, 30),
    })).slice(0, 15),
    images: [...document.querySelectorAll("img[src]")].map((i) => ({
      src: i.currentSrc || i.src || "", alt: i.alt || "", w: i.naturalWidth, h: i.naturalHeight,
    })).filter((i) => i.src && i.src.startsWith("http")).slice(0, 40),
    text: (document.body && document.body.innerText || "").slice(0, 5000),
  };
}
// Arbitrary JS in the page context. Result is JSON-serialized (objects) or a
// short string; errors come back with their message.
function evalFunc(code) {
  try {
    const value = (0, eval)(code);
    if (value === undefined) return { ok: true, value: null, type: "undefined" };
    if (typeof value === "object" && value !== null) {
      return { ok: true, value: JSON.parse(JSON.stringify(value)), type: "json" };
    }
    return { ok: true, value: String(value), type: typeof value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
// Scroll the page; returns the new scroll position.
function scrollFunc(dx, dy, behavior) {
  window.scrollBy({ top: dy, left: dx, behavior: behavior || "auto" });
  return { x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
}
// Element inspector: rect, tag, text, attributes, computed role — for
// coordinate-based agents that need to know what is under a point.
function inspectFunc(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const attrs = {};
  for (const a of el.attributes || []) attrs[a.name] = a.value.slice(0, 120);
  return {
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 120),
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    role: el.getAttribute("role") || "",
    attrs,
  };
}

// ── WebSocket management ────────────────────────────────────────────────────

// Ask the harness to start the local relay if it isn't running. The extension
// cannot spawn processes, so it calls the harness's /api/_relay/start hook.
// Returns true when the relay is (or became) reachable; the caller always
// attempts the socket regardless, because the harness hook may be missing
// (harness not restarted) while the relay itself is already up.
async function ensureRelay() {
  if (settings.autoStartRelay === false) return wsReachable();
  try {
    const res = await fetch(`${settings.harnessUrl}/api/_relay/start`, { method: "POST", cache: "no-store" });
    if (res.ok) {
      const body = await res.json().catch(() => null);
      if (body && body.ok) return true;
    }
  } catch {
    // harness unreachable — fall through and just try the socket
  }
  return wsReachable();
}

async function connect() {
  if (retry) { clearTimeout(retry); retry = null; }
  setState("connecting");
  // If nothing is listening, ask the harness to start the relay first.
  if (!(await wsReachable())) {
    await ensureRelay();
  }
  openSocket();
}

function wsReachable() {
  return new Promise((resolve) => {
    try {
      const probe = new WebSocket(settings.relayUrl);
      const done = (ok) => { try { probe.close(); } catch {} resolve(ok); };
      probe.onopen = () => done(true);
      probe.onerror = () => done(false);
      setTimeout(() => done(false), 1500);
    } catch {
      resolve(false);
    }
  });
}

function openSocket() {
  try {
    ws = new WebSocket(settings.relayUrl);
  } catch { scheduleRetry(); return; }
  ws.onopen = () => {
    setState("connected");
    ws.send(JSON.stringify({ hello: "extension", profile: settings.profileName }));
  };
  ws.onclose = () => {
    setState("disconnected");
    ws = null;
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

// ── Command dispatch ────────────────────────────────────────────────────────

function shouldBringForward(action) {
  if (!settings.focusOnAction) return false;
  // Pure metadata actions never need focus.
  return !METADATA_ACTIONS.has(action);
}

// Actions that never touch a tab: they must not create or steal one.
const METADATA_ACTIONS = new Set([
  "ping", "status", "tabs", "windows", "groups", "activeTab",
  "harnessTab", "newHarnessTab", "reload",
]);

// Actions that still target a tab but must never bring it forward even when
// focusOnAction is on (they are read-only or background-ish).
const NON_FOCUS_ACTIONS = new Set([
  "snap", "page", "eval", "scroll", "inspect", "dialog", "form", "tail",
  "findText", "shot", "screenshot", "reloadTab",
]);

async function dispatchAction(msg, reply) {
  const action = msg.action;

  // Metadata actions run without resolving a tab at all.
  if (METADATA_ACTIONS.has(action)) {
    const value = await runMetadataAction(action, msg);
    return value;
  }

  const tab = await targetTab(msg.tabId);
  await ensureGrouped(tab);

  if (shouldBringForward(action) && !NON_FOCUS_ACTIONS.has(action)) {
    await bringForward(tab).catch(() => {});
  }

  const run = async (func, args) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func,
      args: args || [],
    });
    const r = results && results[0];
    if (r && r.exceptionDetails) {
      throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r && r.result;
  };

  switch (action) {
    case "ping": return "v7";
    case "reload": { setTimeout(() => chrome.runtime.reload(), 400); return "reloading"; }
    case "status": return currentState();
    case "snap": return await run(snapFunc, []);
    case "page": return await run(pageFunc, []);
    case "eval": return await evalViaCdp(tab.id, String(msg.code ?? ""));
    case "scroll": return await run(scrollFunc, [Number(msg.dx || 0), Number(msg.dy || 0), String(msg.behavior || "auto")]);
    case "inspect": return await run(inspectFunc, [Number(msg.x), Number(msg.y)]);
    case "dialog": return await run(dialogFunc, []);
    case "form": return await run(formFunc, []);
    case "click": return await run(actFunc, ["click", String(msg.sel || "")]);
    case "clickXY": return await run(actFunc, ["clickXY", Number(msg.x), Number(msg.y)]);
    case "key": return await run(actFunc, ["key", String(msg.key || ""), Boolean(msg.meta), Boolean(msg.shift)]);
    case "tail": return await run(actFunc, ["tail"]);
    case "hrefs": return await run(actFunc, ["hrefs", String(msg.text || "")]);
    case "clickText": return await run(actFunc, ["clickText", String(msg.text || ""), null, Boolean(msg.exact)]);
    case "findText": return await run(findTextFunc, [String(msg.text || "")]);
    case "fill": return await run(fillFunc, [String(msg.sel || ""), String(msg.value ?? "")]);
    case "type": return await run(actFunc, ["type", String(msg.sel || ""), String(msg.text || "")]);
    case "replace": return await run(actFunc, ["replace", String(msg.sel || ""), String(msg.text || "")]);
    case "shot":
    case "screenshot":
      return await takeScreenshot(tab, msg);
    case "navigate": { await chrome.tabs.update(tab.id, { url: msg.url }); return "navigated"; }
    case "reloadTab": { await chrome.tabs.reload(tab.id); return "reloading tab"; }
    case "tabInfo": {
      const t = await chrome.tabs.get(msg.tabId != null ? msg.tabId : tab.id);
      return { id: t.id, url: t.url || "", title: t.title || "", groupId: t.groupId, windowId: t.windowId, active: t.active, pinned: t.pinned, index: t.index };
    }
    case "closeTab": { await chrome.tabs.remove(tab.id); return "closed"; }
    case "duplicate": {
      const dup = await chrome.tabs.duplicate(tab.id);
      return { tabId: dup.id, url: dup.url || "" };
    }
    case "pin": { await chrome.tabs.update(tab.id, { pinned: true }); return "pinned"; }
    case "unpin": { await chrome.tabs.update(tab.id, { pinned: false }); return "unpinned"; }
    default:
      return reply({ ok: false, error: "unknown action" }) ?? undefined;
  }
}

// Metadata actions: run without touching any tab (never steal or create one).
async function runMetadataAction(action, msg) {
  switch (action) {
    case "ping": return "v7";
    case "status": return currentState();
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      const windows = await chrome.windows.getAll({ populate: false }).catch(() => []);
      const winById = new Map(windows.map((w) => [w.id, w]));
      const groups = await chrome.tabGroups.query({}).catch(() => []);
      const groupById = new Map(groups.map((g) => [g.id, g]));
      return tabs.map((t) => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        groupId: t.groupId,
        groupTitle: t.groupId !== -1 ? (groupById.get(t.groupId)?.title ?? "") : "",
        windowId: t.windowId,
        windowFocused: winById.get(t.windowId)?.focused ?? false,
        index: t.index,
        active: t.active,
        pinned: t.pinned,
        muted: t.mutedInfo?.muted ?? false,
        audible: t.audible ?? false,
        discarded: t.discarded ?? false,
        status: t.status ?? "",
      }));
    }
    case "windows": {
      const windows = await chrome.windows.getAll({ populate: false });
      return windows.map((w) => ({
        id: w.id, focused: w.focused, type: w.type, state: w.state,
        width: w.width, height: w.height, tabs: w.tabs ? w.tabs.length : undefined,
      }));
    }
    case "groups": {
      const groups = await chrome.tabGroups.query({}).catch(() => []);
      return groups.map((g) => ({
        id: g.id, title: g.title, color: g.color, windowId: g.windowId, collapsed: g.collapsed,
      }));
    }
    case "activeTab": {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return t ? { tabId: t.id, windowId: t.windowId, url: t.url || "", title: t.title || "" } : null;
    }
    case "harnessTab": {
      const found = await findHarnessTab();
      return found
        ? { tabId: found.id, windowId: found.windowId, url: found.url || "", title: found.title || "" }
        : null;
    }
    case "newHarnessTab": {
      const created = await createHarnessTab(msg?.url);
      return { tabId: created.id, groupId: created.groupId ?? -1, url: created.url || "" };
    }
    case "reload": {
      setTimeout(() => chrome.runtime.reload(), 400);
      return "reloading";
    }
    default:
      return undefined;
  }
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

function cdpScreenshot(tabId, format) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format }, (res) => {
        chrome.debugger.detach({ tabId }, () => {});
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || !res.data) return reject(new Error("no screenshot data"));
        resolve(`data:image/png;base64,${res.data}`);
      });
    });
  });
}

// Run arbitrary JS in the page's main world via CDP. Unlike the isolated
// world, Runtime.evaluate is not subject to the page's (or the extension's)
// CSP, so eval works even on strict pages. The page context is real: the
// code sees the page's own JS globals, not the isolated world's.
function evalViaCdp(tabId, code) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      chrome.debugger.sendCommand(
        { tabId },
        "Runtime.evaluate",
        { expression: code, returnByValue: true, awaitPromise: true },
        (res) => {
          chrome.debugger.detach({ tabId }, () => {});
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res) return reject(new Error("no eval result"));
          if (res.exceptionDetails) {
            const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "exception";
            return resolve({ ok: false, error: detail });
          }
          const r = res.result;
          if (r?.type === "undefined" || r?.type === "symbol" || r?.type === "function") {
            return resolve({ ok: true, value: null, type: r.type });
          }
          if (r?.type === "object" && !r.value) {
            return resolve({ ok: true, value: null, type: "object" });
          }
          return resolve({ ok: true, value: r?.value ?? r?.description ?? null, type: r?.type });
        }
      );
    });
  });
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

// Resolve which tab a command drives.
//   - Explicit tabId → that tab.
//   - No tabId → an existing Harness-grouped tab (any window), or a freshly
//     created background one. NEVER the user's active tab: the harness must
//     not hijack what the user is looking at.
function targetTab(tabId) {
  if (tabId != null) return chrome.tabs.get(tabId);
  return findHarnessTab().then((found) => {
    if (found) return found;
    return createHarnessTab();
  });
}

// Find a tab already in a group with the configured name, in ANY Chrome
// window. Never the harness GUI tab itself (127.0.0.1:3080) — navigating
// that away kills the working surface.
async function findHarnessTab() {
  const name = settings.groupName || "Harness";
  const groups = await chrome.tabGroups.query({ title: name }).catch(() => []);
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    if (!tabs || !tabs.length) continue;
    const candidate = tabs.find((t) => !(t.url || "").includes("127.0.0.1:3080"));
    if (candidate) return candidate;
  }
  return null;
}

// Create a background grouped tab (never steals focus). Uses the configured
// group name and color, creating the group on first use.
async function createHarnessTab(url) {
  const name = settings.groupName || "Harness";
  const color = settings.groupColor || "red";
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: false });
  const groups = await chrome.tabGroups.query({ title: name }).catch(() => []);
  let groupId = -1;
  if (groups && groups.length) {
    try { groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id }); } catch { groupId = -1; }
  }
  if (groupId === -1) {
    try {
      groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, { title: name, color }).catch(() => {});
    } catch {}
  }
  return tab;
}

// Mark a tab Pilot is driving so it is obvious on screen: a colored group
// with the configured name. Only groups tabs Pilot owns (created here);
// never the user's active tab, because targetTab never returns that.
async function ensureGrouped(tab) {
  if (tab.groupId !== -1) return tab.groupId;
  const name = settings.groupName || "Harness";
  const color = settings.groupColor || "red";
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: name, color }).catch(() => {});
    return groupId;
  } catch (e) {
    return -1;
  }
}

// Only called when the user opted in to focus-stealing (focusOnAction: true).
async function bringForward(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
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

// The worker starts with intent=false: no connect() call here. The popup's
// Connect button is the handshake.
loadSettings();
