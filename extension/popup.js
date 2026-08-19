const label = document.getElementById("label");
const statusEl = document.getElementById("status");
const connectBtn = document.getElementById("connect");
const startRelayBtn = document.getElementById("startRelay");
const disconnectBtn = document.getElementById("disconnect");
const settingsBtn = document.getElementById("settings");
const hint = document.getElementById("hint");
const profileEl = document.getElementById("profile");
const groupNameEl = document.getElementById("groupName");
const relayEl = document.getElementById("relay");
const groupBadge = document.getElementById("groupBadge");

function render(state) {
  if (typeof state === "string") state = { connected: state === "connected", intent: state === "connecting" };
  if (!state) state = {};
  statusEl.className = state.connected ? "connected" : state.intent ? "connecting" : "disconnected";
  label.textContent = state.connected
    ? "Connected to harness"
    : state.intent
      ? "Connecting…"
      : "Disconnected";
  connectBtn.hidden = state.connected || state.intent;
  startRelayBtn.hidden = state.connected || state.intent;
  disconnectBtn.hidden = !state.connected;
  hint.hidden = state.connected || state.intent;
  if (state.profile) profileEl.textContent = state.profile;
  if (state.groupName) {
    groupNameEl.textContent = state.groupName;
    groupBadge.textContent = state.groupName;
  }
  if (state.relay) relayEl.textContent = state.relay;
}

connectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "connect" }, (r) => render(r || {}));
});
startRelayBtn.addEventListener("click", () => {
  startRelayBtn.textContent = "Starting relay…";
  chrome.runtime.sendMessage({ type: "start-relay" }, (r) => {
    startRelayBtn.textContent = "Start relay, then connect";
    render(r || {});
  });
});
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" }, (r) => render(r || {}));
});
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.sendMessage({ type: "state-query" }, (r) => render(r || {}));
chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "state") render(m.state); });
