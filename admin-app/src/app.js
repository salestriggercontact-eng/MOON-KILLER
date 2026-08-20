const state = {
  backendUrl: localStorage.getItem("backendUrl") || "",
  signalingUrl: localStorage.getItem("signalingUrl") || "",
  token: localStorage.getItem("token") || "",
  username: localStorage.getItem("username") || "",
  pc: null,
  ws: null,
  dataChannel: null,
  currentDeviceCode: null,
  currentSessionId: null,
  currentRoomId: null,
  wsReconnectAttempt: 0,
  wsClosedIntentionally: false,
  longPressMode: false,
  mediaRecorder: null,
  recordedChunks: [],
  isRecording: false,
  chunkBuffers: {}, // id -> { totalChunks, received: {}, type }
  swipeStart: null, // {x, y} while a drag is in progress on the video
  lastUiTree: null, // most recently received parsed tree (for UPI/TX search)
  flatNodeIndex: [] // flattened [{nodeId, text, contentDescription, resourceId, node}] built alongside lastUiTree
};

const $ = (id) => document.getElementById(id);

function log(msg) {
  const box = $("logBox");
  const line = document.createElement("div");
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  box.prepend(line);
}

function showView(view) {
  $("loginView").classList.toggle("hidden", view !== "login");
  $("mainView").classList.toggle("hidden", view !== "main");
}

async function api(path, opts = {}) {
  const res = await fetch(`${state.backendUrl}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(opts.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Tabs ----

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "history") loadHistory();
    if (btn.dataset.tab === "deploy") loadApkList();
  });
});

// ---- Login ----

$("loginBtn").addEventListener("click", async () => {
  state.backendUrl = $("serverUrl").value.trim().replace(/\/$/, "");
  state.signalingUrl = $("signalingUrl").value.trim().replace(/\/$/, "");
  const username = $("username").value.trim();
  const password = $("password").value;

  if (!state.backendUrl || !state.signalingUrl || !username || !password) {
    $("loginError").textContent = "All fields are required.";
    return;
  }

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    state.token = data.token;
    state.username = data.username;
    localStorage.setItem("backendUrl", state.backendUrl);
    localStorage.setItem("signalingUrl", state.signalingUrl);
    localStorage.setItem("token", state.token);
    localStorage.setItem("username", state.username);

    $("whoami").textContent = `Logged in as ${state.username}`;
    showView("main");
    refreshDevices();
    setInterval(refreshDevices, 5000);
  } catch (err) {
    $("loginError").textContent = err.message;
  }
});

$("logoutBtn").addEventListener("click", () => {
  localStorage.clear();
  location.reload();
});

// ---- Device list ----

async function refreshDevices() {
  try {
    const devices = await api("/api/devices");
    const list = $("deviceList");
    list.innerHTML = "";
    devices.forEach((d) => {
      const el = document.createElement("div");
      el.className = "device-item";
      el.innerHTML = `
        <span class="dot ${d.isOnline ? "online" : ""}"></span>
        <div style="flex:1">
          <div>${d.deviceModel}</div>
          <div style="font-size:11px;color:var(--muted)">${d.deviceCode}</div>
        </div>
      `;
      el.addEventListener("click", (e) => connectToDevice(d.deviceCode));

      const unpairBtn = document.createElement("button");
      unpairBtn.textContent = "✕";
      unpairBtn.title = "Unpair";
      unpairBtn.style.cssText = "background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;";
      unpairBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Unpair ${d.deviceCode}?`)) return;
        await api("/api/devices/unpair", { method: "POST", body: JSON.stringify({ deviceCode: d.deviceCode }) });
        refreshDevices();
      });
      el.appendChild(unpairBtn);

      list.appendChild(el);
    });
  } catch (err) {
    log(`Device list error: ${err.message}`);
  }
}

// ---- Pairing ----

$("pairBtn").addEventListener("click", () => {
  $("pairModal").classList.remove("hidden");
  $("pairStatus").textContent = "";
  $("pairingCodeInput").value = "";
});
$("cancelPairBtn").addEventListener("click", () => {
  $("pairModal").classList.add("hidden");
});

$("submitPairBtn").addEventListener("click", async () => {
  const pairingCode = $("pairingCodeInput").value.trim();
  if (pairingCode.length !== 6) {
    $("pairStatus").textContent = "Enter the 6-digit code.";
    return;
  }
  try {
    const { requestId } = await api("/api/devices/pair", {
      method: "POST",
      body: JSON.stringify({ pairingCode })
    });
    $("pairStatus").textContent = "Waiting for approval on phone...";

    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const status = await api(`/api/devices/request-status/${requestId}`);
      if (status.status === "approved") {
        $("pairStatus").textContent = "Paired!";
        await sleep(800);
        $("pairModal").classList.add("hidden");
        refreshDevices();
        return;
      }
      if (status.status === "denied") {
        $("pairStatus").textContent = "Denied on phone.";
        return;
      }
    }
    $("pairStatus").textContent = "Timed out waiting for approval.";
  } catch (err) {
    $("pairStatus").textContent = err.message;
  }
});

// ---- Connect / session ----

async function connectToDevice(deviceCode) {
  try {
    $("sessionStatus").textContent = "Requesting connection - waiting for approval on phone...";
    const { requestId, signalingRoom } = await api("/api/devices/request-connect", {
      method: "POST",
      body: JSON.stringify({ deviceCode })
    });

    let approved = false;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const status = await api(`/api/devices/request-status/${requestId}`);
      if (status.status === "approved") { approved = true; break; }
      if (status.status === "denied") {
        $("sessionStatus").textContent = "User denied the session on their phone.";
        return;
      }
    }
    if (!approved) {
      $("sessionStatus").textContent = "Timed out waiting for approval (phone may be offline).";
      return;
    }

    const session = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ deviceCode, signalingRoom })
    });
    state.currentSessionId = session._id;
    state.currentDeviceCode = deviceCode;

    startWebRTC(signalingRoom);
  } catch (err) {
    $("sessionStatus").textContent = `Error: ${err.message}`;
    log(`Connect error: ${err.message}`);
  }
}

function startWebRTC(roomId) {
  state.currentRoomId = roomId;
  state.wsClosedIntentionally = false;
  state.wsReconnectAttempt = 0;
  openSignalingSocket(roomId);
}

function openSignalingSocket(roomId) {
  state.ws = new WebSocket(state.signalingUrl);

  state.ws.onopen = () => {
    state.wsReconnectAttempt = 0;
    state.ws.send(JSON.stringify({ type: "join", roomId, role: "admin", token: state.token }));
  };

  state.ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "peer-joined" && msg.role === "phone") {
      log("Phone connected. Starting screen share request...");
      await createOfferAndSend();
    }

    if (msg.type === "offer") {
      // Sent again after the phone renegotiates (e.g. camera toggle)
      await state.pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      state.ws.send(JSON.stringify({ type: "answer", answer }));
    }

    if (msg.type === "answer") {
      await state.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
    }

    if (msg.type === "ice-candidate" && msg.candidate) {
      try {
        await state.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (e) {
        log(`ICE error: ${e.message}`);
      }
    }

    if (msg.type === "peer-left" && msg.role === "phone") {
      log("Phone disconnected.");
      endSession("phone_disconnected");
    }
  };

  state.ws.onerror = () => log("Signaling connection error.");
  state.ws.onclose = () => {
    if (state.wsClosedIntentionally) return;
    if (!state.currentSessionId) return; // session already ended cleanly
    log("Signaling connection lost - reconnecting...");
    state.wsReconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, Math.min(state.wsReconnectAttempt, 5)), 15000);
    setTimeout(() => {
      if (!state.wsClosedIntentionally && state.currentSessionId) {
        openSignalingSocket(state.currentRoomId);
      }
    }, delay);
  };
}

async function createOfferAndSend() {
  state.pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: "turn:free.expressturn.com:3478",
        username: "000000002102532665",
        credential: "TOF0yG1CBWto3Y5A5T7RtpQFbQs="
      }
    ]
  });

  state.pc.onicecandidate = (e) => {
    if (e.candidate) {
      state.ws.send(JSON.stringify({ type: "ice-candidate", candidate: e.candidate }));
    }
  };

  state.pc.onconnectionstatechange = () => {
    log(`Connection state: ${state.pc.connectionState}`);
    if (state.pc.connectionState === "failed") {
      // Save whatever was recorded so far rather than losing it, then
      // tear down - there is no automatic WebRTC-level reconnect here
      // (see README "Known limitations").
      if (state.isRecording) stopRecording();
      endSession("ice_failed");
    }
  };

  state.pc.ontrack = (e) => {
    const streamId = e.streams[0]?.id || "";
    if (streamId.includes("camera")) {
      $("cameraVideo").srcObject = e.streams[0];
    } else {
      $("remoteVideo").srcObject = e.streams[0];
    }
  };

  state.dataChannel = state.pc.createDataChannel("control");
  state.dataChannel.onopen = () => {
    $("sessionStatus").textContent = `Active session with ${state.currentDeviceCode}`;
    $("stopSessionBtn").classList.remove("hidden");
    $("controlBar").classList.remove("hidden");
    $("scrollBar").classList.remove("hidden");
    $("textInputRow").classList.remove("hidden");
    $("featureRow").classList.remove("hidden");
    log("Session active.");
  };
  state.dataChannel.onmessage = (e) => handleDataChannelMessage(e.data);

  const offer = await state.pc.createOffer({ offerToReceiveVideo: true });
  await state.pc.setLocalDescription(offer);
  state.ws.send(JSON.stringify({ type: "offer", offer }));
}

// ---- Data channel message handling (control acks + chunked transfers) ----

function handleDataChannelMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const type = msg.type || "";

  if (type.endsWith("-start")) {
    const baseType = type.replace("-start", "");
    state.chunkBuffers[msg.id] = { type: baseType, totalChunks: msg.totalChunks, received: {} };
    return;
  }
  if (type.endsWith("-chunk")) {
    const buf = state.chunkBuffers[msg.id];
    if (buf) buf.received[msg.index] = msg.data;
    return;
  }
  if (type.endsWith("-end")) {
    const buf = state.chunkBuffers[msg.id];
    if (!buf) return;
    let full = "";
    for (let i = 0; i < buf.totalChunks; i++) full += buf.received[i] || "";
    delete state.chunkBuffers[msg.id];
    onChunkedPayloadComplete(buf.type, full);
    return;
  }

  if (type === "control_result") {
    if (!msg.success) {
      log(`Control "${msg.command}" failed: ${msg.error || "unknown error"}`);
    }
    return;
  }
  if (type === "accessibility_action_result") {
    if (msg.success) {
      log(`Action ${msg.action} on ${msg.nodeId} succeeded.`);
    } else {
      log(`Action ${msg.action} on ${msg.nodeId} failed: ${msg.error || "unknown error"}`);
    }
    return;
  }
  if (type === "ui-tree-stale") {
    $("uiTreeStaleHint").classList.remove("hidden");
    return;
  }
  if (type === "screenshot-error") {
    $("screenshotHint").textContent = msg.error;
    log(`Screenshot error: ${msg.error}`);
    return;
  }
  if (type === "camera-started") {
    $("cameraToggleBtn").textContent = "Stop Camera";
    $("switchCameraBtn").classList.remove("hidden");
    log(`Camera started (${msg.facing || "unknown"}).`);
    return;
  }
  if (type === "camera-stopped") {
    $("cameraToggleBtn").textContent = "Start Camera";
    $("switchCameraBtn").classList.add("hidden");
    $("cameraVideo").srcObject = null;
    log("Camera stopped.");
    return;
  }
  if (type === "camera-switched") {
    log(`Camera switched to ${msg.facing}.`);
    return;
  }
  if (type === "camera-error") {
    log(`Camera error: ${msg.error}`);
    return;
  }
}

function onChunkedPayloadComplete(type, data) {
  if (type === "ui-tree") {
    try {
      const parsed = JSON.parse(data);
      renderUiTree(parsed);
      log(`UI tree received (${parsed.nodeCount ?? "?"} nodes).`);
    } catch {
      $("uiTreeBox").textContent = data;
    }
  }
  if (type === "screenshot") {
    const img = $("screenshotImg");
    img.src = `data:image/jpeg;base64,${data}`;
    img.classList.remove("hidden");
    $("screenshotHint").textContent = "";
    $("saveScreenshotBtn").classList.remove("hidden");
    $("saveScreenshotBtn").dataset.base64 = data;
    log("Screenshot received.");
  }
}

function renderUiTree(parsed) {
  const box = $("uiTreeBox");
  box.innerHTML = "";
  $("uiTreeDetail").innerHTML = '<p class="hint">Click a node to inspect it.</p>';
  $("nodeActions").classList.add("hidden");
  $("uiTreeStaleHint").classList.add("hidden");

  if (parsed.error) {
    box.innerHTML = `<p class="hint">${parsed.error}</p>`;
    state.lastUiTree = null;
    state.flatNodeIndex = [];
    return;
  }

  state.lastUiTree = parsed;
  state.flatNodeIndex = [];

  const header = document.createElement("div");
  header.className = "hint";
  header.textContent = `Package: ${parsed.packageName || "unknown"} - ${parsed.nodeCount ?? "?"} nodes`;
  box.appendChild(header);

  function renderNode(node, depth) {
    state.flatNodeIndex.push(node);
    const row = document.createElement("div");
    row.className = "tree-node";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const label = node.text || node.contentDescription || node.resourceId || node.className || "(view)";
    row.textContent = label;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".tree-node.selected").forEach((n) => n.classList.remove("selected"));
      row.classList.add("selected");
      showNodeDetail(node);
    });
    box.appendChild(row);
    (node.children || []).forEach((child) => renderNode(child, depth + 1));
  }

  if (parsed.tree) renderNode(parsed.tree, 0);
}

function showNodeDetail(node) {
  const detail = $("uiTreeDetail");
  const fields = [
    ["nodeId", node.nodeId],
    ["packageName", node.packageName],
    ["className", node.className],
    ["text", node.isPassword ? "(password field - not exposed)" : node.text],
    ["contentDescription", node.contentDescription],
    ["resourceId", node.resourceId],
    ["bounds", node.bounds ? `${node.bounds.left},${node.bounds.top} - ${node.bounds.right},${node.bounds.bottom}` : ""],
    ["clickable", node.clickable],
    ["longClickable", node.longClickable],
    ["editable", node.editable],
    ["enabled", node.enabled],
    ["focusable", node.focusable],
    ["focused", node.focused],
    ["scrollable", node.scrollable],
    ["checked", node.checked],
    ["selected", node.selected]
  ];
  detail.innerHTML = fields.map(([k, v]) => `<div><strong>${k}:</strong> ${v}</div>`).join("");

  renderNodeActions(node);
}

function renderNodeActions(node) {
  const wrap = $("nodeActions");
  const actions = node.availableActions || [];
  if (actions.length === 0) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = "";

  actions.forEach((action) => {
    if (action === "SET_TEXT") {
      const input = document.createElement("input");
      input.placeholder = "Text to set";
      input.id = "nodeSetTextInput";
      wrap.appendChild(input);
      const btn = document.createElement("button");
      btn.textContent = "SET_TEXT";
      btn.addEventListener("click", () => performNodeAction(node.nodeId, "SET_TEXT", input.value));
      wrap.appendChild(btn);
    } else {
      const btn = document.createElement("button");
      btn.textContent = action;
      btn.addEventListener("click", () => performNodeAction(node.nodeId, action));
      wrap.appendChild(btn);
    }
  });
}

function performNodeAction(nodeId, action, text) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  const payload = { type: "accessibility_action", nodeId, action };
  if (text !== undefined) payload.text = text;
  state.dataChannel.send(JSON.stringify(payload));
}

$("refreshUiTreeBtn").addEventListener("click", () => {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  $("uiTreeBox").textContent = "Loading...";
  $("uiTreeStaleHint").classList.add("hidden");
  state.dataChannel.send(JSON.stringify({ type: "get-ui-tree" }));
});

// ---- UPI/TX: search over the already-fetched tree only (no new
// Android-side capability - this is client-side filtering of data the
// admin already received via get-ui-tree, itself gated on the same
// active-session consent as everything else) ----

$("upiSearchBtn").addEventListener("click", () => {
  const query = $("upiSearchInput").value.trim().toLowerCase();
  const results = $("upiResults");
  results.innerHTML = "";

  if (!state.lastUiTree) {
    results.innerHTML = '<p class="hint">No UI tree loaded yet - open the UI Tree tab and tap Refresh first.</p>';
    return;
  }
  if (!query) return;

  const matches = state.flatNodeIndex.filter((n) => {
    const haystack = `${n.text || ""} ${n.contentDescription || ""} ${n.resourceId || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  if (matches.length === 0) {
    results.innerHTML = '<p class="hint">No matching on-screen elements.</p>';
    return;
  }

  matches.forEach((node) => {
    const el = document.createElement("div");
    el.className = "tree-node";
    el.textContent = node.text || node.contentDescription || node.resourceId || "(view)";
    el.addEventListener("click", () => {
      document.querySelector('.tab-btn[data-tab="uitree"]').click();
      showNodeDetail(node);
    });
    results.appendChild(el);
  });
});

// ---- Video tap / long-press / swipe (drag) to control ----

function sendControl(command, extra = {}) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  state.dataChannel.send(JSON.stringify({ type: "control", command, ...extra }));
}

function videoFraction(e) {
  const rect = $("remoteVideo").getBoundingClientRect();
  return {
    x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1),
    y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1)
  };
}

$("remoteVideo").addEventListener("pointerdown", (e) => {
  state.swipeStart = videoFraction(e);
});

$("remoteVideo").addEventListener("pointerup", (e) => {
  if (!state.swipeStart) return;
  const start = state.swipeStart;
  const end = videoFraction(e);
  state.swipeStart = null;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 0.02) {
    // Treated as a tap (or long-press, if the toggle is on)
    sendControl(state.longPressMode ? "long_press" : "tap", { x: start.x, y: start.y });
  } else {
    sendControl("swipe", { x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs: 300 });
  }
});

$("longPressToggle").addEventListener("click", () => {
  state.longPressMode = !state.longPressMode;
  $("longPressToggle").textContent = `Long-press mode: ${state.longPressMode ? "On" : "Off"}`;
  $("longPressToggle").classList.toggle("active", state.longPressMode);
});

document.querySelectorAll("#controlBar button[data-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => sendControl(btn.dataset.cmd));
});

document.querySelectorAll("#scrollBar button[data-scroll]").forEach((btn) => {
  btn.addEventListener("click", () => sendControl("scroll", { direction: btn.dataset.scroll }));
});

$("sendTextBtn").addEventListener("click", () => {
  const text = $("typeTextInput").value;
  if (!text) return;
  sendControl("type_text", { text });
});

// ---- Feature row: camera, screenshot, ui tree, recording ----

$("cameraToggleBtn").addEventListener("click", () => {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  const starting = $("cameraToggleBtn").textContent.includes("Start");
  state.dataChannel.send(JSON.stringify({ type: starting ? "start-camera" : "stop-camera" }));
});

$("switchCameraBtn").addEventListener("click", () => {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  state.dataChannel.send(JSON.stringify({ type: "switch-camera" }));
});

$("screenshotBtn").addEventListener("click", () => {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  $("screenshotHint").textContent = "Capturing...";
  $("saveScreenshotBtn").classList.add("hidden");
  $("screenshotImg").classList.add("hidden");
  state.dataChannel.send(JSON.stringify({ type: "screenshot" }));
  document.querySelector('.tab-btn[data-tab="screenshot"]').click();
});

$("saveScreenshotBtn").addEventListener("click", async () => {
  const base64 = $("saveScreenshotBtn").dataset.base64;
  if (!base64 || !window.electronAPI) return;
  const name = `screenshot-${state.currentDeviceCode}-${Date.now()}.jpg`;
  const result = await window.electronAPI.saveFile(name, base64);
  if (result.ok) log(`Screenshot saved to ${result.path}`);
  else if (!result.canceled) log(`Save failed: ${result.error}`);
});

$("uiTreeBtn").addEventListener("click", () => {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    log("Unavailable on this Android/device state: no active session.");
    return;
  }
  $("uiTreeBox").textContent = "Loading...";
  state.dataChannel.send(JSON.stringify({ type: "get-ui-tree" }));
  document.querySelector('.tab-btn[data-tab="uitree"]').click();
});

$("recordToggleBtn").addEventListener("click", () => {
  if (!state.isRecording) startRecording();
  else stopRecording();
});

function startRecording() {
  const stream = $("remoteVideo").srcObject;
  if (!stream) { log("No active video stream to record."); return; }

  state.recordedChunks = [];
  try {
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
  } catch (e) {
    log(`Recording not supported: ${e.message}`);
    return;
  }
  state.mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) state.recordedChunks.push(e.data);
  };
  state.mediaRecorder.onstop = async () => {
    const blob = new Blob(state.recordedChunks, { type: "video/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const name = `session-recording-${state.currentDeviceCode}-${timestampForFilename()}.webm`;
    if (window.electronAPI) {
      const result = await window.electronAPI.saveFile(name, base64);
      if (result.ok) log(`Recording saved to ${result.path}`);
      else if (!result.canceled) log(`Save failed: ${result.error}`);
    }
  };

  state.mediaRecorder.start();
  state.isRecording = true;
  $("recordToggleBtn").textContent = "Stop Recording";
  $("recordToggleBtn").classList.add("recording");
  log("Recording started.");
}

function stopRecording() {
  state.mediaRecorder?.stop();
  state.isRecording = false;
  $("recordToggleBtn").textContent = "Start Recording";
  $("recordToggleBtn").classList.remove("recording");
  log("Recording stopped.");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---- Stop session ----

$("stopSessionBtn").addEventListener("click", () => {
  if (state.isRecording) stopRecording();
  if (state.ws) state.ws.send(JSON.stringify({ type: "stop-session" }));
  endSession("admin_stopped");
});

async function endSession(reason = "admin_stopped") {
  state.wsClosedIntentionally = true;
  const cameraUsed = $("cameraToggleBtn").textContent.includes("Stop");

  if (state.currentSessionId) {
    try {
      await api(`/api/sessions/${state.currentSessionId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "ended", cameraUsed, disconnectReason: reason })
      });
    } catch {}
  }
  if (state.pc) state.pc.close();
  if (state.ws) state.ws.close();
  state.pc = null;
  state.ws = null;
  state.dataChannel = null;
  state.currentSessionId = null;
  state.currentRoomId = null;
  $("remoteVideo").srcObject = null;
  $("cameraVideo").srcObject = null;
  $("sessionStatus").textContent = "No active session";
  $("stopSessionBtn").classList.add("hidden");
  $("controlBar").classList.add("hidden");
  $("scrollBar").classList.add("hidden");
  $("textInputRow").classList.add("hidden");
  $("featureRow").classList.add("hidden");
  $("cameraToggleBtn").textContent = "Start Camera";
  $("switchCameraBtn").classList.add("hidden");
  log("Session ended.");
}

// ---- History tab ----

async function loadHistory() {
  try {
    const sessions = await api("/api/sessions");
    const box = $("historyList");
    box.innerHTML = "";
    if (sessions.length === 0) {
      box.innerHTML = '<p class="hint">No sessions yet.</p>';
      return;
    }
    sessions.forEach((s) => {
      const el = document.createElement("div");
      el.className = "history-item";
      const started = s.startedAt ? new Date(s.startedAt).toLocaleString() : "-";
      const ended = s.endedAt ? new Date(s.endedAt).toLocaleString() : "-";
      const duration = s.durationSeconds != null ? `${Math.floor(s.durationSeconds / 60)}m ${s.durationSeconds % 60}s` : "-";
      el.innerHTML = `
        <div><strong>${s.deviceCode}</strong> - <span class="status-${s.status}">${s.status}</span></div>
        <div>Started: ${started}</div>
        <div>Ended: ${ended}</div>
        <div>Duration: ${duration}</div>
        <div>Camera used: ${s.cameraUsed ? "Yes" : "No"}</div>
        ${s.disconnectReason ? `<div>Disconnect reason: ${s.disconnectReason}</div>` : ""}
      `;
      box.appendChild(el);
    });
  } catch (err) {
    log(`History load error: ${err.message}`);
  }
}

// ---- Deploy tab ----

$("uploadApkBtn").addEventListener("click", () => {
  const fileInput = $("apkFileInput");
  const file = fileInput.files[0];
  if (!file) { log("Choose an APK file first."); return; }

  const formData = new FormData();
  formData.append("apk", file);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${state.backendUrl}/api/deploy/apk`);
  xhr.setRequestHeader("Authorization", `Bearer ${state.token}`);

  $("uploadProgressWrap").classList.remove("hidden");
  $("uploadProgressBar").style.width = "0%";

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      $("uploadProgressBar").style.width = `${pct}%`;
    }
  };

  xhr.onload = () => {
    $("uploadProgressWrap").classList.add("hidden");
    if (xhr.status >= 200 && xhr.status < 300) {
      log("APK uploaded.");
      fileInput.value = "";
      loadApkList();
    } else {
      const err = JSON.parse(xhr.responseText || "{}").error || "Upload failed";
      log(`Upload error: ${err}`);
    }
  };
  xhr.onerror = () => {
    $("uploadProgressWrap").classList.add("hidden");
    log("Upload failed (network error).");
  };

  xhr.send(formData);
});

async function loadApkList() {
  try {
    const builds = await api("/api/deploy/apk");
    const box = $("apkList");
    box.innerHTML = "";
    if (builds.length === 0) {
      box.innerHTML = '<p class="hint">No APKs uploaded yet.</p>';
      return;
    }
    builds.forEach((b) => {
      const el = document.createElement("div");
      el.className = "apk-item";
      const sizeMb = (b.sizeBytes / (1024 * 1024)).toFixed(1);
      const fullUrl = `${state.backendUrl}${b.downloadUrl}`;
      el.innerHTML = `
        <div><strong>${b.originalName}</strong> (${sizeMb} MB)</div>
        <div class="hint">Uploaded by ${b.uploadedByAdmin} - ${b.downloadCount} downloads</div>
        <div class="apk-actions">
          <button class="copy-link">Copy Link</button>
          <button class="delete-apk">Delete</button>
        </div>
      `;
      el.querySelector(".copy-link").addEventListener("click", () => {
        navigator.clipboard.writeText(fullUrl);
        log("Download link copied.");
      });
      el.querySelector(".delete-apk").addEventListener("click", async () => {
        if (!confirm(`Delete ${b.originalName}?`)) return;
        await api(`/api/deploy/apk/${b.id}`, { method: "DELETE" });
        loadApkList();
      });
      box.appendChild(el);
    });
  } catch (err) {
    log(`APK list error: ${err.message}`);
  }
}

// ---- Restore session on reload ----

if (state.token) {
  $("whoami").textContent = `Logged in as ${state.username}`;
  showView("main");
  refreshDevices();
  setInterval(refreshDevices, 5000);
}
