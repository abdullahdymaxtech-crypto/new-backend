const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ==========================================
// WebSocket server - PERFORMANCE OPTIMIZED
// ==========================================
const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false,       // CRITICAL: disable compression for speed
    maxPayload: 5 * 1024 * 1024,   // 5MB max message - netplay sync data can be large
    backlog: 100,
});

const rooms = {};
const tcpTunnels = {};

function generateCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

// Clean up stale rooms older than 2 hours
setInterval(() => {
    const now = Date.now();
    for (const code in rooms) {
        if (now - rooms[code].createdAt > 2 * 60 * 60 * 1000) {
            if (rooms[code].wsClients) {
                rooms[code].wsClients.forEach((client) => {
                    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                        client.ws.close();
                    }
                });
            }
            if (tcpTunnels[code]) {
                cleanupTunnel(code);
            }
            delete rooms[code];
            console.log(`Room ${code} cleaned up (expired)`);
        }
    }
}, 60000);

function cleanupTunnel(code) {
    const tunnel = tcpTunnels[code];
    if (!tunnel) return;
    console.log(`[Tunnel ${code}] Cleaning up`);
    if (tunnel.hostWs && tunnel.hostWs.readyState === WebSocket.OPEN) {
        tunnel.hostWs.close();
    }
    if (tunnel.clientWs && tunnel.clientWs.readyState === WebSocket.OPEN) {
        tunnel.clientWs.close();
    }
    delete tcpTunnels[code];
}

// ==========================================
// REST API Endpoints
// ==========================================
app.post("/create-room", (req, res) => {
    const code = generateCode();
    const playerId = generateId();
    const { hostIp, hostPort } = req.body;

    rooms[code] = {
        code,
        hostIp: hostIp || req.ip,
        hostPort: hostPort || 45000,
        started: false,
        hostId: playerId,
        createdAt: Date.now(),
        useRelay: false,
        players: [
            {
                id: playerId,
                name: "Host",
                slot: 1,
                publicIp: req.headers["x-forwarded-for"] || req.ip,
            },
        ],
        wsClients: new Map(),
        gameFrames: [],
    };

    console.log(`Room ${code} created by ${playerId}, hostIp=${hostIp}`);
    res.json({
        code,
        playerId,
        hostIp: rooms[code].hostIp,
        hostPort: rooms[code].hostPort,
    });
});

app.post("/join-room", (req, res) => {
    const { code, name } = req.body;
    const room = rooms[code];

    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.players.length >= 4)
        return res.status(400).json({ error: "room full" });

    const playerId = generateId();
    const slot = room.players.length + 1;
    const joinerPublicIp = req.headers["x-forwarded-for"] || req.ip;

    const player = {
        id: playerId,
        name: name || "Player",
        slot,
        publicIp: joinerPublicIp,
    };
    room.players.push(player);

    const hostPublicIp = room.players[0].publicIp;
    if (hostPublicIp !== joinerPublicIp) {
        room.useRelay = true;
        console.log(
            `Room ${code}: Different networks detected (${hostPublicIp} vs ${joinerPublicIp}), relay enabled`
        );
    }

    console.log(
        `Player ${name || "Player"} joined room ${code} as slot ${slot}, relay=${room.useRelay}`
    );

    res.json({
        playerId,
        slot,
        hostIp: room.hostIp,
        hostPort: room.hostPort,
        useRelay: room.useRelay,
    });
});

app.get("/room/:code", (req, res) => {
    const code = req.params.code;
    const room = rooms[code];
    if (!room) return res.status(404).json({ error: "room not found" });

    res.json({
        code: room.code,
        hostIp: room.hostIp,
        hostPort: room.hostPort,
        started: room.started,
        hostId: room.hostId,
        useRelay: room.useRelay,
        players: room.players.map((p) => ({
            id: p.id,
            name: p.name,
            slot: p.slot,
        })),
    });
});

app.post("/kick", (req, res) => {
    const { code, hostId, playerId } = req.body;
    const room = rooms[code];

    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.hostId !== hostId)
        return res.status(403).json({ error: "not host" });

    if (room.wsClients.has(playerId)) {
        const client = room.wsClients.get(playerId);
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(
                JSON.stringify({ type: "kicked", reason: "Host kicked you" })
            );
            client.ws.close();
        }
        room.wsClients.delete(playerId);
    }

    room.players = room.players.filter((p) => p.id !== playerId);
    res.json({ success: true });
});

app.post("/start", (req, res) => {
    const { code, hostId } = req.body;
    const room = rooms[code];

    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.hostId !== hostId)
        return res.status(403).json({ error: "not host" });

    room.started = true;

    room.wsClients.forEach((client) => {
        if (client.ws && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(
                JSON.stringify({
                    type: "game_started",
                    useRelay: room.useRelay,
                })
            );
        }
    });

    console.log(`Room ${code} game started, relay=${room.useRelay}`);
    res.json({ started: true, useRelay: room.useRelay });
});

app.get("/health", (req, res) => {
    const roomCount = Object.keys(rooms).length;
    let totalWsClients = 0;
    for (const code in rooms) {
        totalWsClients += rooms[code].wsClients.size;
    }
    const tunnelCount = Object.keys(tcpTunnels).length;
    res.json({
        status: "ok",
        rooms: roomCount,
        wsClients: totalWsClients,
        activeTunnels: tunnelCount,
        uptime: process.uptime(),
    });
});

// ==========================================
// WebSocket handling
// ==========================================
wss.on("connection", (ws, req) => {
    let clientRoomCode = null;
    let clientPlayerId = null;
    let clientSlot = 0;
    let isTcpTunnel = false;
    let tunnelRole = null;

    // Set socket-level options for low latency
    if (ws._socket) {
        ws._socket.setNoDelay(true);
    }

    ws.on("message", (data) => {
        // ============================================
        // TCP TUNNEL MODE: forward raw bytes directly
        // ============================================
        if (isTcpTunnel) {
            const tunnel = tcpTunnels[clientRoomCode];
            if (!tunnel) return;

            // Determine target WebSocket
            let targetWs = null;
            if (tunnelRole === "host" && tunnel.clientWs) {
                targetWs = tunnel.clientWs;
            } else if (tunnelRole === "client" && tunnel.hostWs) {
                targetWs = tunnel.hostWs;
            }

            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                console.log(`[Tunnel ${clientRoomCode}] ${tunnelRole}→peer: ${data.length}B buf=${targetWs.bufferedAmount}`);
                targetWs.send(data, { binary: true, compress: false });
            }
            return;
        }

        // ============================================
        // NORMAL MODE: JSON control messages + voice
        // ============================================
        try {
            let msg;

            if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
                const bytes =
                    data instanceof ArrayBuffer
                        ? Buffer.from(data)
                        : data;

                const msgType = bytes[0];

                if (msgType === 0x01 || msgType === 0x02) {
                    if (clientRoomCode && rooms[clientRoomCode]) {
                        const room = rooms[clientRoomCode];
                        room.wsClients.forEach((client, pid) => {
                            if (
                                pid !== clientPlayerId &&
                                client.ws &&
                                client.ws.readyState === WebSocket.OPEN
                            ) {
                                client.ws.send(data, { binary: true });
                            }
                        });
                    }
                    return;
                }

                msg = JSON.parse(bytes.toString("utf8"));
            } else {
                msg = JSON.parse(data);
            }

            handleControlMessage(ws, msg);
        } catch (e) {
            if (clientRoomCode && rooms[clientRoomCode]) {
                const room = rooms[clientRoomCode];
                room.wsClients.forEach((client, pid) => {
                    if (
                        pid !== clientPlayerId &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(data, { binary: true });
                    }
                });
            }
        }
    });

    function handleControlMessage(ws, msg) {
        switch (msg.type) {
            case "tcp_tunnel": {
                const { roomCode, role } = msg;
                const room = rooms[roomCode];

                if (!room) {
                    ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
                    return;
                }

                if (!room.useRelay) {
                    ws.send(JSON.stringify({ type: "tcp_tunnel_status", status: "not_needed" }));
                    return;
                }

                clientRoomCode = roomCode;
                isTcpTunnel = true;
                tunnelRole = role;

                if (!tcpTunnels[roomCode]) {
                    tcpTunnels[roomCode] = {
                        hostWs: null,
                        clientWs: null,
                        hostReady: false,
                        clientReady: false,
                        createdAt: Date.now(),
                    };
                }

                const tunnel = tcpTunnels[roomCode];

                if (role === "host") {
                    if (tunnel.hostWs && tunnel.hostWs !== ws && tunnel.hostWs.readyState === WebSocket.OPEN) {
                        tunnel.hostWs.close();
                    }
                    tunnel.hostWs = ws;
                    tunnel.hostReady = true;
                    console.log(`[Tunnel ${roomCode}] HOST WebSocket connected`);
                } else if (role === "client") {
                    if (tunnel.clientWs && tunnel.clientWs !== ws && tunnel.clientWs.readyState === WebSocket.OPEN) {
                        tunnel.clientWs.close();
                    }
                    tunnel.clientWs = ws;
                    tunnel.clientReady = true;
                    console.log(`[Tunnel ${roomCode}] CLIENT WebSocket connected`);
                } else {
                    ws.send(JSON.stringify({ type: "error", message: "Invalid role" }));
                    return;
                }

                ws.send(JSON.stringify({
                    type: "tcp_tunnel_status",
                    status: "connected",
                    role: role,
                    peerConnected: role === "host" ? tunnel.clientReady : tunnel.hostReady,
                }));

                if (tunnel.hostReady && tunnel.clientReady) {
                    console.log(`[Tunnel ${roomCode}] Both sides connected, tunnel is ACTIVE`);

                    if (tunnel.hostWs && tunnel.hostWs.readyState === WebSocket.OPEN) {
                        tunnel.hostWs.send(JSON.stringify({
                            type: "tcp_tunnel_status",
                            status: "active",
                            role: "host",
                            peerConnected: true,
                        }));
                    }
                    if (tunnel.clientWs && tunnel.clientWs.readyState === WebSocket.OPEN) {
                        tunnel.clientWs.send(JSON.stringify({
                            type: "tcp_tunnel_status",
                            status: "active",
                            role: "client",
                            peerConnected: true,
                        }));
                    }
                }

                break;
            }

            case "join_relay": {
                const { roomCode, playerId } = msg;
                const room = rooms[roomCode];

                if (!room) {
                    ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
                    return;
                }

                const player = room.players.find((p) => p.id === playerId);
                if (!player) {
                    ws.send(JSON.stringify({ type: "error", message: "Player not in room" }));
                    return;
                }

                clientRoomCode = roomCode;
                clientPlayerId = playerId;
                clientSlot = player.slot;

                room.wsClients.set(playerId, {
                    ws,
                    slot: player.slot,
                    name: player.name,
                });

                ws.send(
                    JSON.stringify({
                        type: "relay_joined",
                        slot: player.slot,
                        useRelay: room.useRelay,
                        players: room.players.map((p) => ({
                            slot: p.slot,
                            name: p.name,
                        })),
                    })
                );

                room.wsClients.forEach((client, pid) => {
                    if (
                        pid !== playerId &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(
                            JSON.stringify({
                                type: "player_connected",
                                slot: player.slot,
                                name: player.name,
                            })
                        );
                    }
                });

                console.log(
                    `Player ${player.name} (slot ${player.slot}) connected to relay in room ${roomCode}`
                );
                break;
            }

            case "netplay_input": {
                if (!clientRoomCode || !rooms[clientRoomCode]) return;
                const room = rooms[clientRoomCode];

                room.wsClients.forEach((client, pid) => {
                    if (
                        pid !== clientPlayerId &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(
                            JSON.stringify({
                                type: "netplay_input",
                                slot: clientSlot,
                                frame: msg.frame,
                                input: msg.input,
                            })
                        );
                    }
                });
                break;
            }

            case "netplay_sync": {
                if (!clientRoomCode || !rooms[clientRoomCode]) return;
                const room = rooms[clientRoomCode];

                room.wsClients.forEach((client, pid) => {
                    if (
                        pid !== clientPlayerId &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(JSON.stringify(msg));
                    }
                });
                break;
            }

            case "voice_offer":
            case "voice_answer":
            case "voice_ice": {
                if (!clientRoomCode || !rooms[clientRoomCode]) return;
                const room = rooms[clientRoomCode];
                const targetSlot = msg.targetSlot;

                room.wsClients.forEach((client, pid) => {
                    if (
                        client.slot === targetSlot &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(
                            JSON.stringify({
                                ...msg,
                                fromSlot: clientSlot,
                            })
                        );
                    }
                });
                break;
            }

            case "voice_data": {
                if (!clientRoomCode || !rooms[clientRoomCode]) return;
                const room = rooms[clientRoomCode];

                room.wsClients.forEach((client, pid) => {
                    if (
                        pid !== clientPlayerId &&
                        client.ws &&
                        client.ws.readyState === WebSocket.OPEN
                    ) {
                        client.ws.send(
                            JSON.stringify({
                                type: "voice_data",
                                fromSlot: clientSlot,
                                audio: msg.audio,
                                timestamp: msg.timestamp,
                            })
                        );
                    }
                });
                break;
            }

            case "ping": {
                ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
                break;
            }

            default:
                console.log("Unknown message type:", msg.type);
        }
    }

    ws.on("close", () => {
        if (isTcpTunnel && clientRoomCode && tcpTunnels[clientRoomCode]) {
            const tunnel = tcpTunnels[clientRoomCode];
            if (tunnelRole === "host") {
                tunnel.hostWs = null;
                tunnel.hostReady = false;
                console.log(`[Tunnel ${clientRoomCode}] HOST disconnected`);
                if (tunnel.clientWs && tunnel.clientWs.readyState === WebSocket.OPEN) {
                    tunnel.clientWs.send(JSON.stringify({
                        type: "tcp_tunnel_status",
                        status: "peer_disconnected",
                    }));
                }
            } else if (tunnelRole === "client") {
                tunnel.clientWs = null;
                tunnel.clientReady = false;
                console.log(`[Tunnel ${clientRoomCode}] CLIENT disconnected`);
                if (tunnel.hostWs && tunnel.hostWs.readyState === WebSocket.OPEN) {
                    tunnel.hostWs.send(JSON.stringify({
                        type: "tcp_tunnel_status",
                        status: "peer_disconnected",
                    }));
                }
            }

            if (!tunnel.hostReady && !tunnel.clientReady) {
                delete tcpTunnels[clientRoomCode];
                console.log(`[Tunnel ${clientRoomCode}] Cleaned up (both sides gone)`);
            }
            return;
        }

        if (clientRoomCode && rooms[clientRoomCode]) {
            const room = rooms[clientRoomCode];
            room.wsClients.delete(clientPlayerId);

            room.wsClients.forEach((client) => {
                if (client.ws && client.ws.readyState === WebSocket.OPEN) {
                    client.ws.send(
                        JSON.stringify({
                            type: "player_disconnected",
                            slot: clientSlot,
                        })
                    );
                }
            });

            console.log(
                `Player slot ${clientSlot} disconnected from room ${clientRoomCode}`
            );
        }
    });

    ws.on("error", (err) => {
        console.error("WebSocket error:", err.message);
    });
});

// ==========================================
// Start server
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`REST API + WebSocket + TCP Tunnel: port ${PORT}`);
});
