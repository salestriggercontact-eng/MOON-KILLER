require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });

const rooms = new Map();
const RELAYABLE_TYPES = new Set(["offer", "answer", "ice-candidate", "stop-session"]);

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

wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.role = null;
    ws.roomId = null;

    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return;
        }
        if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") return;

        if (msg.type === "join") {
            const { roomId, role, token } = msg;
            if (!roomId || (role !== "admin" && role !== "phone")) {
                ws.close();
                return;
            }
            if (role === "admin") {
                try {
                    jwt.verify(token, process.env.JWT_SECRET);
                } catch {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid token" }));
                    ws.close();
                    return;
                }
            }
            const room = getRoom(roomId);
            if (room[role] && room[role].readyState === WebSocket.OPEN) {
                room[role].close();
            }
            room[role] = ws;
            ws.role = role;
            ws.roomId = roomId;
            ws.send(JSON.stringify({ type: "joined", role }));

            // If both are present, notify admin
            if (room.admin && room.phone && room.admin.readyState === WebSocket.OPEN) {
                console.log(`[both present] roomId=${roomId} - notifying admin`);
                room.admin.send(JSON.stringify({ type: "peer-joined", role: "phone" }));
            }
            return;
        }

        // Relay other messages
        if (!RELAYABLE_TYPES.has(msg.type)) {
            console.log(`[dropped] non-relayable type: ${msg.type}`);
            return;
        }
        if (!ws.roomId || !ws.role) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const target = ws.role === "phone" ? room.admin : room.phone;
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

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 6000;
server.listen(PORT, () => console.log(`Signaling server running on port ${PORT}`));
