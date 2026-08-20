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
  profileName: "default",
  focusOnAction: false,
  visualFeedback: true,
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
  };
}

// ── page functions (run in the tab's isolated world; no eval, CSP-safe) ─────
// ONE self-contained function per injection: Chrome serializes the function
// body into the page but NOT the helpers it references, so every helper is
// inlined. Visual feedback: a soft glow around the tab edge + a cursor arrow
// at the last interaction point.
function actFunc(mode, a, b, c, d) {
  const base = "cb-bridge-";
  // Last arg: whether to draw the glow + cursor. Off for clean recordings.
  const showFeedback = d !== false;
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
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    if (showFeedback) {
      const cursor = ensureArm();
      cursor.style.left = x + "px";
      cursor.style.top = y + "px";
      cursor.style.display = "block";
    }
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
// fillShadow pierces shadow roots and iframes to reach an input by a partial
// match on name, placeholder, aria-label, or data-testid. Stripe's hosted
// checkout renders its fields inside shadow DOM, where querySelector cannot
// go, so the normal fill action never finds them.
function fillShadowFunc(value) {
  const seen = new Set();
  const walk = (root) => {
    for (const el of root.querySelectorAll("input, textarea, select")) {
      const key = el === document.activeElement;
      const id = [el.name, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("data-testid")]
        .filter(Boolean).join("|").toLowerCase();
      if (id.includes("machine") || id.includes("ids")) {
        const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype :
          el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return "filled shadow: " + id;
      }
    }
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) {
        seen.add(el.shadowRoot);
        const r = walk(el.shadowRoot);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(document) || "NOT FOUND shadow machine field";
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

// ── WebSocket management ────────────────────────────────────────────────────

function connect() {
  if (retry) { clearTimeout(retry); retry = null; }
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
  return !["ping", "tabs", "harnessTab", "newHarnessTab", "reload", "status"].includes(action);
}

async function dispatchAction(msg, reply) {
  const action = msg.action;
  const tab = await targetTab(msg.tabId);
  await ensureGrouped(tab);

  if (shouldBringForward(action)) {
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
    case "dialog": return await run(dialogFunc, []);
    case "form": return await run(formFunc, []);
    case "click": return await run(actFunc, ["click", String(msg.sel || ""), null, null, settings.visualFeedback]);
    case "clickXY": return await run(actFunc, ["clickXY", Number(msg.x), Number(msg.y), null, settings.visualFeedback]);
    case "key": return await run(actFunc, ["key", String(msg.key || ""), Boolean(msg.meta), Boolean(msg.shift), settings.visualFeedback]);
    case "tail": return await run(actFunc, ["tail", null, null, null, settings.visualFeedback]);
    case "hrefs": return await run(actFunc, ["hrefs", String(msg.text || ""), null, null, settings.visualFeedback]);
    case "clickText": return await run(actFunc, ["clickText", String(msg.text || ""), null, Boolean(msg.exact), settings.visualFeedback]);
    case "findText": return await run(findTextFunc, [String(msg.text || "")]);
    case "fill": return await run(fillFunc, [String(msg.sel || ""), String(msg.value ?? "")]);
    case "fillShadow": return await run(fillShadowFunc, [String(msg.value || "")]);
    case "type": return await run(actFunc, ["type", String(msg.sel || ""), String(msg.text || ""), null, settings.visualFeedback]);
    case "replace": return await run(actFunc, ["replace", String(msg.sel || ""), String(msg.text || ""), null, settings.visualFeedback]);
    case "shot":
    case "screenshot":
      return await takeScreenshot(tab, msg);
    case "navigate": { await chrome.tabs.update(tab.id, { url: msg.url }); return "navigated"; }
    case "tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, url: t.url || "", title: t.title || "", groupId: t.groupId, windowId: t.windowId, active: t.active }));
    }
    case "harnessTab": {
      const groups = await chrome.tabGroups.query({ title: "Harness" }).catch(() => []);
      let found = null;
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id });
        if (!tabs || !tabs.length) continue;
        const candidate = tabs.find((t) => !(t.url || "").includes("127.0.0.1:3080"));
        if (candidate) { found = candidate; break; }
      }
      return found
        ? { tabId: found.id, windowId: found.windowId, url: found.url || "", title: found.title || "" }
        : null;
    }
    case "newHarnessTab": {
      const tab = await chrome.tabs.create({ url: msg.url || "about:blank", active: false });
      const groups = await chrome.tabGroups.query({ title: "Harness" }).catch(() => []);
      let groupId = -1;
      if (groups && groups.length) {
        try { groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id }); } catch { groupId = -1; }
      }
      if (groupId === -1) {
        try {
          groupId = await chrome.tabs.group({ tabIds: [tab.id] });
          await chrome.tabGroups.update(groupId, { title: "Harness", color: "red" }).catch(() => {});
        } catch {}
      }
      return { tabId: tab.id, groupId, url: tab.url || "" };
    }
    default:
      return reply({ ok: false, error: "unknown action" }) ?? undefined;
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

function targetTab(tabId) {
  if (tabId != null) return chrome.tabs.get(tabId);
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]);
}

// Mark the tab the harness is driving so it is obvious on screen: a red
// "Harness" tab group. Creates the group on first use.
async function ensureGrouped(tab) {
  if (tab.groupId !== -1) return tab.groupId;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: "Harness", color: "red" }).catch(() => {});
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
