// Pilot CLI — pure helpers: the action list and help, reply shaping, the
// compact snap format. No I/O, so the tests run them directly.

// Every action with one example. help prints this; the CLI checks actions
// against it so a typo fails fast with the nearest match.
const ACTIONS = {
  claim: ['{"action":"claim"} --session job', "pin a background tab for your session (do this first)"],
  navigate: ['{"action":"navigate","url":"https://example.com"}', "open a URL and wait for it to load"],
  snap: ['{"action":"snap"}', "see the page: one line per item, ref first (\"full\":true for JSON, \"filter\":\"interactive\" for items only)"],
  click: ['{"action":"click","ref":"p1r3"}', "click an item by ref (also \"sel\":\"css\")"],
  clickText: ['{"action":"clickText","text":"Sign in"}', "click by visible text (\"exact\":true to pin it)"],
  clickN: ['{"action":"clickN","n":3}', "click item n of the last snap (n is shown with \"full\":true; prefer refs)"],
  clickXY: ['{"action":"clickXY","x":300,"y":200}', "click at viewport pixels"],
  hover: ['{"action":"hover","ref":"p1r3"}', "move the mouse onto an item without clicking"],
  hoverXY: ['{"action":"hoverXY","x":300,"y":200}', "move the mouse to viewport pixels"],
  type: ['{"action":"type","ref":"p1r4","text":"hello"}', "set a text field to the text (\"text\":\"\" needs \"clear\":true)"],
  replace: ['{"action":"replace","ref":"p1r4","text":"hello"}', "same as type"],
  typeKeys: ['{"action":"typeKeys","ref":"p1r4","text":"4242"}', "real keystrokes, for masked fields"],
  fill: ['{"action":"fill","ref":"p1r5","value":"2026-10-08"}', "set a field or select (selects match value or label; date/time/number are checked first)"],
  fillShadow: ['{"action":"fillShadow","match":"email","value":"a@b.c"}', "set a field inside shadow DOM by name/label"],
  upload: ['{"action":"upload","ref":"p1r6","path":"/abs/file.pdf"}', "put a file into a file input"],
  drag: ['{"action":"drag","from":"p1r2","to":"p1r9"}', "drag one item onto another"],
  key: ['{"action":"key","key":"Enter"}', "press a key in the focused field (\"meta\":true, \"shift\":true)"],
  scroll: ['{"action":"scroll","dy":600}', "scroll down 600px (or \"to\":\"top\"|\"bottom\", or \"ref\":\"p1r9\" to bring it into view)"],
  wait: ['{"action":"wait","text":"Hello World!"}', "wait until text shows (\"sel\":\"css\", \"gone\":\"Loading\", \"ms\":1000; \"timeout\":10000)"],
  back: ['{"action":"back"}', "browser Back"],
  forward: ['{"action":"forward"}', "browser Forward"],
  read: ['{"action":"read"}', "all page text, 12000 chars at a time (\"offset\":12000 for more)"],
  text: ['{"action":"text"}', "main article text without menus, header or footer"],
  findText: ['{"action":"findText","text":"Total"}', "where text is on the page, with refs you can click"],
  form: ['{"action":"form"}', "every field with its value, plus field errors and missing required fields"],
  dialog: ['{"action":"dialog"}', "text of the open on-page dialog and the last alert/confirm/prompt"],
  dialogPolicy: ['{"action":"dialogPolicy","accept":false}', "how to answer alert/confirm/prompt (default accept; \"promptText\":\"x\", \"once\":true)"],
  eval: ['{"action":"eval","js":"document.title"}', "run JavaScript in the page, get the JSON result"],
  console: ['{"action":"console","level":"error"}', "recent console messages and page errors"],
  network: ['{"action":"network","failed":true}', "recent network requests (\"failed\":true for errors only)"],
  hrefs: ['{"action":"hrefs","text":"docs"}', "links whose text or URL contains the text"],
  tail: ['{"action":"tail"}', "the last 3000 chars of page text"],
  shot: ['{"action":"shot"} --out /tmp/p.jpg', "screenshot to a file; read it with ./ocr /tmp/p.jpg"],
  tabs: ['{"action":"tabs"}', "list every open tab"],
  activeTab: ['{"action":"activeTab"}', "the tab the user is looking at (Pilot never changes it)"],
  release: ['{"action":"release"} --session job', "close your tab and the tabs it opened (always do this when done)"],
  guard: ['{"action":"guard"} --session job', "bring your tab back to the last URL you navigated to"],
  cleanup: ['{"action":"cleanup"}', "list stale Pilot tabs that would be closed (\"apply\":true to close them)"],
  status: ['{"action":"status"}', "is the extension connected"],
  reload: ['{"action":"reload"}', "reload the extension (only after updating Pilot's code; wait 4s)"],
  help: ['{"action":"help"}', "this list"],
};

const EXTRA_ACTIONS = ["ping", "windows", "tabInfo", "closeTab", "harnessTab", "newHarnessTab", "gc", "releaseTab", "screenshot"];
const KNOWN = new Set([...Object.keys(ACTIONS), ...EXTRA_ACTIONS]);

function helpText() {
  const lines = [
    "Pilot — drive a Chrome tab. One JSON command per call:",
    "  node cli.js '<json>' --session NAME",
    "",
    "Loop: claim -> navigate -> snap -> act by ref -> snap again -> ... -> release",
    "Every reply has ok. ok:false means it did not work: read error and hint.",
    "",
  ];
  const w = Math.max(...Object.keys(ACTIONS).map((k) => k.length));
  for (const [name, [ex, what]] of Object.entries(ACTIONS)) {
    lines.push(name.padEnd(w) + "  " + ex);
    lines.push(" ".repeat(w) + "  " + what);
  }
  lines.push("", "Flags: --session NAME (always) | --profile NAME | --tab ID (drive a tab you were told about, e.g. opened.tabId) | --out FILE | --status | --sessions");
  return lines.join("\n");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// The closest known action to a typo, or null.
function nearestAction(name, list) {
  const want = String(name || "").toLowerCase();
  const all = list || [...Object.keys(ACTIONS)];
  let best = null, score = Infinity;
  for (const a of all) {
    const al = a.toLowerCase();
    if (al === want) return a;
    let s = levenshtein(want, al);
    if (al.startsWith(want) || want.startsWith(al)) s = Math.min(s, 1);
    if (s < score) { best = a; score = s; }
  }
  return score <= Math.max(2, Math.floor(want.length / 3)) ? best : null;
}

function unknownAction(name) {
  const near = nearestAction(name);
  return {
    ok: false,
    error: "unknown action '" + name + "'",
    hint: (near ? "did you mean \"" + near + "\"? " : "") + "run {\"action\":\"help\"} for every action with an example",
  };
}

// One truth for ok. The extension wraps results as { ok: true, value }, and
// many values carry their own ok/error/hint; lift those to the top so ok
// at the top is the real outcome. Data stays under value.
const LIFT = ["error", "hint", "dialog", "opened", "navigated"];
function shapeReply(res) {
  if (!res || typeof res !== "object") return { ok: false, error: "empty reply" };
  if (!res.ok) {
    const out = { ok: false, error: res.error || "failed" };
    for (const k of Object.keys(res)) if (!["id", "ok", "error", "type"].includes(k)) out[k] = res[k];
    return out;
  }
  const v = res.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: true, value: v === undefined ? null : v };
  const out = { ok: v.ok === undefined ? true : !!v.ok };
  const rest = { ...v };
  delete rest.ok;
  for (const k of LIFT) {
    if (rest[k] !== undefined) { out[k] = rest[k]; delete rest[k]; }
  }
  if (Object.keys(rest).length) out.value = rest;
  return out;
}

// ── compact snap ────────────────────────────────────────────────────────────

const q = (s) => '"' + String(s).replace(/\s+/g, " ").replace(/"/g, "'").slice(0, 60) + '"';

function itemLine(it) {
  let s = it.ref + " " + (it.role || it.tag || "item");
  if (it.name) s += " " + q(it.name);
  else if (it.icon) s += " (icon)";
  if (it.value !== undefined && it.value !== "" && !/^(button|link)$/.test(it.role)) s += " =" + q(it.value);
  else if (it.value === "" && it.role && /textbox|searchbox|combobox|spinbutton/.test(it.role)) s += " (empty)";
  if (it.checked === true) s += " [checked]";
  else if (it.checked === false) s += " [unchecked]";
  if (it.expanded === true) s += " [expanded]";
  if (it.required) s += " [required]";
  if (it.disabled) s += " [disabled]";
  if (it.readonly) s += " [readonly]";
  if (it.newTab) s += " [opens new tab]";
  if (it.frame) s += " [frame " + it.frame + "]";
  return s;
}

// The snap as a few short lines: header, a slice of the page text, then one
// line per item, on-screen items first. Fits `budget` bytes (default 3800).
function formatSnap(v, opts) {
  const o = opts || {};
  const budget = o.budget || 3800;
  const interactive = o.filter === "interactive";
  const head = [];
  head.push("ok:true page " + (v.doc != null ? "p" + v.doc : "?") + " " + q(v.title || "") + " " + (v.url || ""));
  if (v.dialog) head.push("dialog open: " + q(v.dialog) + " (its items are listed first)");
  if (v.frames && v.frames.length) head.push("frames: " + v.frames.map((f) => "[frame " + f.frame + "] " + f.url).join(" ; "));
  if (v.unreadableFrames && v.unreadableFrames.length) head.push("could not read " + v.unreadableFrames.length + " frame(s): " + v.unreadableFrames.slice(0, 2).join(" ; "));
  if (!interactive && v.text) {
    const t = String(v.text).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " | ").trim();
    const max = o.textMax || 700;
    head.push("text: " + (t.length > max ? t.slice(0, max) + " …(read for more)" : t));
  }
  const items = v.items || [];
  head.push("items (" + items.length + (v.total && v.total > items.length ? " of " + v.total : "") + "), on screen first; act with the ref, e.g. {\"action\":\"click\",\"ref\":\"" + (items[0] ? items[0].ref : "p1r1") + "\"}:");
  const lines = [...head];
  let size = lines.join("\n").length;
  let shown = 0;
  let foldMarked = false;
  for (const it of items) {
    let line = itemLine(it);
    if (!foldMarked && it.pri === 2) {
      line = "-- below the screen (scroll to reach) --\n" + line;
      foldMarked = true;
    }
    if (size + line.length + 1 > budget - 120) break;
    lines.push(line);
    size += line.length + 1;
    shown++;
  }
  const left = items.length - shown + Math.max(0, (v.total || 0) - items.length);
  if (left > 0) lines.push("… " + left + " more items not shown — scroll, findText, or {\"action\":\"snap\",\"full\":true}");
  if (!items.length) lines.push("(no clickable items — try wait, scroll, or read)");
  lines.push("refs are valid until the page changes; after a navigation, snap again.");
  return lines.join("\n");
}

module.exports = { ACTIONS, KNOWN, helpText, nearestAction, unknownAction, shapeReply, formatSnap, itemLine };
