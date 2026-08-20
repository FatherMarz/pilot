const label = document.getElementById("label");
const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");
const settingsBtn = document.getElementById("settings");
const hint = document.getElementById("hint");
const profileEl = document.getElementById("profile");
const groupNameEl = document.getElementById("groupName");
const relayEl = document.getElementById("relay");

function render(state) {
  if (typeof state === "string") state = { connected: state === "connected", intent: state === "connecting" };
  if (!state) state = {};
  // Keep the status-row layout class; only swap the state modifier. The old
  // code replaced the whole className, which dropped "status-row" and left the
  // label as bare text hugging the popup's left edge.
  statusEl.className = "status-row " + (state.connected ? "connected" : state.intent ? "connecting" : "disconnected");
  label.textContent = state.connected
    ? "Connected to harness"
    : state.intent
      ? "Connecting…"
      : "Disconnected";
  connectBtn.hidden = state.connected || state.intent;
  disconnectBtn.hidden = !state.connected;
  hint.hidden = state.connected || state.intent;
  if (state.profile) profileEl.textContent = state.profile;
  if (state.groupName) groupNameEl.textContent = state.groupName;
  if (state.relay) relayEl.textContent = state.relay;
}

// One button. Connect auto-starts the relay (via the harness hook) when
// nothing is listening, then handshakes. The background handles it; we just
// show "Starting…" while it works.
connectBtn.addEventListener("click", () => {
  connectBtn.classList.add("starting");
  connectBtn.textContent = "Starting…";
  chrome.runtime.sendMessage({ type: "connect" }, (r) => {
    connectBtn.classList.remove("starting");
    connectBtn.textContent = "Connect";
    render(r || {});
  });
});
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" }, (r) => render(r || {}));
});
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.sendMessage({ type: "state-query" }, (r) => render(r || {}));
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "state") render(m.state); });
