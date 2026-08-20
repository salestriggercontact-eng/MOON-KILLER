require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 }); // 256KB hard cap per frame

// rooms: Map<roomId, { phone: ws|null, admin: ws|null }>
const rooms = new Map();

// Everything actually relayed through this server (join is handled
// separately below). Remote-control commands, screenshots, camera
// events, and device info all travel peer-to-peer over the WebRTC
// data channel instead - not through this relay - so they are
// deliberately not in this list. Anything not in RELAYABLE_TYPES is
// dropped rather than forwarded.
const RELAYABLE_TYPES = new Set(["offer", "answer", "ice-candidate", "stop-session"]);

const MAX_MESSAGES_PER_WINDOW = 60;
const RATE_WINDOW_MS = 10_000;

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { phone: null, admin: null });
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && !room.phone && !room.admin) {
    rooms.delete(roomId);
  }
}

function isRateLimited(ws) {
  const now = Date.now();
  if (!ws.rateWindowStart || now - ws.rateWindowStart > RATE_WINDOW_MS) {
    ws.rateWindowStart = now;
    ws.rateCount = 0;
  }
  ws.rateCount++;
  return ws.rateCount > MAX_MESSAGES_PER_WINDOW;
}

app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.role = null;
  ws.roomId = null;

  ws.on("message", (raw) => {
    if (isRateLimited(ws)) {
      ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
      return;
    }

    // First message must be a "join"
    if (msg.type === "join") {
      const { roomId, role, token } = msg;
      console.log(`[join attempt] role=${role} roomId=${roomId}`);
      if (typeof roomId !== "string" || !roomId || (role !== "admin" && role !== "phone")) {
        console.log(`[join rejected] bad roomId/role`);
        return ws.close();
      }

      // Admin side must present a valid JWT. Phone side authenticates
      // implicitly by knowing the one-time signalingRoom id, which was
      // only ever handed to it after on-device user approval.
      if (role === "admin") {
        try {
          jwt.verify(token, process.env.JWT_SECRET);
        } catch {
          console.log(`[join rejected] invalid admin token`);
          ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
          return ws.close();
        }
      }

      const room = getRoom(roomId);

      // Replace any stale connection for this role instead of rejecting
      if (room[role] && room[role].readyState === WebSocket.OPEN) {
        room[role].close();
      }
      room[role] = ws;
      ws.role = role;
      ws.roomId = roomId;

      console.log(`[joined] role=${role} roomId=${roomId} otherPresent=${!!(role === "phone" ? room.admin : room.phone)}`);

      ws.send(JSON.stringify({ type: "joined", role }));

      const other = role === "phone" ? room.admin : room.phone;
      if (other && other.readyState === WebSocket.OPEN) {
        other.send(JSON.stringify({ type: "peer-joined", role }));
      }
      return;
    }

    // Reject any message type we don't explicitly relay - this server
    // never accepts or executes arbitrary message types.
    if (!RELAYABLE_TYPES.has(msg.type)) {
      console.log(`[dropped] non-relayable type: ${msg.type}`);
      return;
    }

    if (!ws.roomId || !ws.role) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const target = ws.role === "phone" ? room.admin : room.phone;
    console.log(`[relay] ${msg.type} from=${ws.role} roomId=${ws.roomId} targetPresent=${!!target} targetOpen=${target && target.readyState === WebSocket.OPEN}`);
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify(msg));
    }
  });

  ws.on("close", () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room && ws.role) {
        room[ws.role] = null;
        const other = ws.role === "phone" ? room.admin : room.phone;
        if (other && other.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: "peer-left", role: ws.role }));
        }
        cleanupRoom(ws.roomId);
      }
    }
  });
});

// Heartbeat to drop dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

const PORT = process.env.PORT || 6000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
