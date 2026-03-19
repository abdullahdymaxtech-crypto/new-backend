const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ==========================================
// WebSocket server for game data relay + voice + TCP tunnel
// ==========================================
const wss = new WebSocket.Server({ server });

const rooms = {};

// ==========================================
// TCP Tunnel sessions (for internet multiplayer)
// Maps roomCode -> { hostWs, clientWs, hostReady, clientReady }
// ==========================================
const tcpTunnels = {};

// ==========================================
// Utility functions
// ==========================================
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
            // Clean up tunnel
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

    // Check if players are on different networks
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

    // Notify all WebSocket clients that game has started
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

// Health check
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
    let isTcpTunnel = false; // If true, this WS is used for TCP tunneling
    let tunnelRole = null;   // "host" or "client"

    ws.on("message", (data) => {
        // ============================================
        // TCP TUNNEL MODE: forward raw bytes directly
        // ============================================
        if (isTcpTunnel) {
            const tunnel = tcpTunnels[clientRoomCode];
            if (!tunnel) return;

            // Forward binary data to the other side
            if (tunnelRole === "host" && tunnel.clientWs && tunnel.clientWs.readyState === WebSocket.OPEN) {
                tunnel.clientWs.send(data, { binary: true });
            } else if (tunnelRole === "client" && tunnel.hostWs && tunnel.hostWs.readyState === WebSocket.OPEN) {
                tunnel.hostWs.send(data, { binary: true });
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

            // =============================================
            // TCP TUNNEL: Host or Client registers for
            // binary TCP data relay through WebSocket
            // =============================================
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
                tunnelRole = role; // "host" or "client"

                // Create tunnel session if it doesn't exist
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
                    // If there's an old host connection, close it
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
                    ws.send(JSON.stringify({ type: "error", message: "Invalid role, use 'host' or 'client'" }));
                    return;
                }

                // Notify the connecting side about status
                ws.send(JSON.stringify({
                    type: "tcp_tunnel_status",
                    status: "connected",
                    role: role,
                    peerConnected: role === "host" ? tunnel.clientReady : tunnel.hostReady,
                }));

                // If both sides are connected, notify both
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

            // =============================================
            // Existing handlers (UNCHANGED)
            // =============================================
            case "join_relay": {
                const { roomCode, playerId } = msg;
                const room = rooms[roomCode];

                if (!room) {
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            message: "Room not found",
                        })
                    );
                    return;
                }

                const player = room.players.find((p) => p.id === playerId);
                if (!player) {
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            message: "Player not in room",
                        })
                    );
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
        // Handle TCP tunnel disconnection
        if (isTcpTunnel && clientRoomCode && tcpTunnels[clientRoomCode]) {
            const tunnel = tcpTunnels[clientRoomCode];
            if (tunnelRole === "host") {
                tunnel.hostWs = null;
                tunnel.hostReady = false;
                console.log(`[Tunnel ${clientRoomCode}] HOST disconnected`);
                // Notify client that host disconnected
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

            // Clean up tunnel if both sides are gone
            if (!tunnel.hostReady && !tunnel.clientReady) {
                delete tcpTunnels[clientRoomCode];
                console.log(`[Tunnel ${clientRoomCode}] Cleaned up (both sides gone)`);
            }
            return;
        }

        // Handle normal WS disconnection
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

// const express = require("express");
// const cors = require("cors");
// const http = require("http");
// const WebSocket = require("ws");

// const app = express();
// app.use(cors());
// app.use(express.json());

// const server = http.createServer(app);

// // ==========================================
// // WebSocket server for game data relay + voice
// // ==========================================
// const wss = new WebSocket.Server({ server });

// const rooms = {};

// // ==========================================
// // Utility functions
// // ==========================================
// function generateCode() {
//     const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
//     let code = "";
//     for (let i = 0; i < 4; i++) {
//         code += chars[Math.floor(Math.random() * chars.length)];
//     }
//     return code;
// }

// function generateId() {
//     return Math.random().toString(36).substring(2, 10);
// }

// // Clean up stale rooms older than 2 hours
// setInterval(() => {
//     const now = Date.now();
//     for (const code in rooms) {
//         if (now - rooms[code].createdAt > 2 * 60 * 60 * 1000) {
//             // Close all WebSocket connections for this room
//             if (rooms[code].wsClients) {
//                 rooms[code].wsClients.forEach((client) => {
//                     if (client.ws && client.ws.readyState === WebSocket.OPEN) {
//                         client.ws.close();
//                     }
//                 });
//             }
//             delete rooms[code];
//             console.log(`Room ${code} cleaned up (expired)`);
//         }
//     }
// }, 60000);

// // ==========================================
// // REST API Endpoints (unchanged interface)
// // ==========================================
// app.post("/create-room", (req, res) => {
//     const code = generateCode();
//     const playerId = generateId();
//     const { hostIp, hostPort } = req.body;

//     rooms[code] = {
//         code,
//         hostIp: hostIp || req.ip,
//         hostPort: hostPort || 45000,
//         started: false,
//         hostId: playerId,
//         createdAt: Date.now(),
//         useRelay: false, // Will be set to true when players are on different networks
//         players: [
//             {
//                 id: playerId,
//                 name: "Host",
//                 slot: 1,
//                 publicIp: req.headers["x-forwarded-for"] || req.ip,
//             },
//         ],
//         // WebSocket clients mapped by playerId
//         wsClients: new Map(),
//         // Game data relay buffer
//         gameFrames: [],
//     };

//     console.log(`Room ${code} created by ${playerId}, hostIp=${hostIp}`);

//     res.json({
//         code,
//         playerId,
//         hostIp: rooms[code].hostIp,
//         hostPort: rooms[code].hostPort,
//     });
// });

// app.post("/join-room", (req, res) => {
//     const { code, name } = req.body;
//     const room = rooms[code];

//     if (!room) return res.status(404).json({ error: "room not found" });
//     if (room.players.length >= 4)
//         return res.status(400).json({ error: "room full" });

//     const playerId = generateId();
//     const slot = room.players.length + 1;
//     const joinerPublicIp = req.headers["x-forwarded-for"] || req.ip;

//     const player = {
//         id: playerId,
//         name: name || "Player",
//         slot,
//         publicIp: joinerPublicIp,
//     };
//     room.players.push(player);

//     // Check if players are on different networks
//     const hostPublicIp = room.players[0].publicIp;
//     if (hostPublicIp !== joinerPublicIp) {
//         room.useRelay = true;
//         console.log(
//             `Room ${code}: Different networks detected (${hostPublicIp} vs ${joinerPublicIp}), relay enabled`
//         );
//     }

//     console.log(
//         `Player ${name || "Player"} joined room ${code} as slot ${slot}, relay=${room.useRelay}`
//     );

//     res.json({
//         playerId,
//         slot,
//         hostIp: room.hostIp,
//         hostPort: room.hostPort,
//         useRelay: room.useRelay,
//     });
// });

// app.get("/room/:code", (req, res) => {
//     const code = req.params.code;
//     const room = rooms[code];

//     if (!room) return res.status(404).json({ error: "room not found" });

//     res.json({
//         code: room.code,
//         hostIp: room.hostIp,
//         hostPort: room.hostPort,
//         started: room.started,
//         hostId: room.hostId,
//         useRelay: room.useRelay,
//         players: room.players.map((p) => ({
//             id: p.id,
//             name: p.name,
//             slot: p.slot,
//         })),
//     });
// });

// app.post("/kick", (req, res) => {
//     const { code, hostId, playerId } = req.body;
//     const room = rooms[code];

//     if (!room) return res.status(404).json({ error: "room not found" });
//     if (room.hostId !== hostId)
//         return res.status(403).json({ error: "not host" });

//     // Close kicked player's WebSocket
//     if (room.wsClients.has(playerId)) {
//         const client = room.wsClients.get(playerId);
//         if (client.ws && client.ws.readyState === WebSocket.OPEN) {
//             client.ws.send(
//                 JSON.stringify({ type: "kicked", reason: "Host kicked you" })
//             );
//             client.ws.close();
//         }
//         room.wsClients.delete(playerId);
//     }

//     room.players = room.players.filter((p) => p.id !== playerId);
//     res.json({ success: true });
// });

// app.post("/start", (req, res) => {
//     const { code, hostId } = req.body;
//     const room = rooms[code];

//     if (!room) return res.status(404).json({ error: "room not found" });
//     if (room.hostId !== hostId)
//         return res.status(403).json({ error: "not host" });

//     room.started = true;

//     // Notify all WebSocket clients that game has started
//     room.wsClients.forEach((client) => {
//         if (client.ws && client.ws.readyState === WebSocket.OPEN) {
//             client.ws.send(
//                 JSON.stringify({
//                     type: "game_started",
//                     useRelay: room.useRelay,
//                 })
//             );
//         }
//     });

//     console.log(`Room ${code} game started, relay=${room.useRelay}`);
//     res.json({ started: true, useRelay: room.useRelay });
// });

// // Health check
// app.get("/health", (req, res) => {
//     const roomCount = Object.keys(rooms).length;
//     let totalWsClients = 0;
//     for (const code in rooms) {
//         totalWsClients += rooms[code].wsClients.size;
//     }
//     res.json({
//         status: "ok",
//         rooms: roomCount,
//         wsClients: totalWsClients,
//         uptime: process.uptime(),
//     });
// });

// // ==========================================
// // WebSocket handling for relay + voice
// // ==========================================
// wss.on("connection", (ws, req) => {
//     let clientRoomCode = null;
//     let clientPlayerId = null;
//     let clientSlot = 0;

//     console.log("New WebSocket connection");

//     ws.on("message", (data) => {
//         try {
//             // Try to parse as JSON first (control messages and voice)
//             let msg;
//             let isBinary = false;

//             if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
//                 // Could be binary game data or binary-encoded JSON
//                 const bytes =
//                     data instanceof ArrayBuffer
//                         ? Buffer.from(data)
//                         : data;

//                 // Check if first byte indicates message type
//                 // Protocol: first byte = type
//                 //   0x01 = game input data (relay to all others)
//                 //   0x02 = voice audio data (relay to all others)
//                 //   0x10+ = JSON control message
//                 const msgType = bytes[0];

//                 if (msgType === 0x01 || msgType === 0x02) {
//                     // Binary relay data
//                     isBinary = true;
//                     if (clientRoomCode && rooms[clientRoomCode]) {
//                         const room = rooms[clientRoomCode];
//                         // Relay to all other players in the room
//                         room.wsClients.forEach((client, pid) => {
//                             if (
//                                 pid !== clientPlayerId &&
//                                 client.ws &&
//                                 client.ws.readyState === WebSocket.OPEN
//                             ) {
//                                 client.ws.send(data, { binary: true });
//                             }
//                         });
//                     }
//                     return;
//                 }

//                 // Try parsing as JSON
//                 msg = JSON.parse(bytes.toString("utf8"));
//             } else {
//                 msg = JSON.parse(data);
//             }

//             handleControlMessage(ws, msg);
//         } catch (e) {
//             // If we can't parse, it might be raw binary game data
//             // Relay it as-is to other players
//             if (clientRoomCode && rooms[clientRoomCode]) {
//                 const room = rooms[clientRoomCode];
//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         pid !== clientPlayerId &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(data, { binary: true });
//                     }
//                 });
//             }
//         }
//     });

//     function handleControlMessage(ws, msg) {
//         switch (msg.type) {
//             case "join_relay": {
//                 // Player connects to relay with their room code and player ID
//                 const { roomCode, playerId } = msg;
//                 const room = rooms[roomCode];

//                 if (!room) {
//                     ws.send(
//                         JSON.stringify({
//                             type: "error",
//                             message: "Room not found",
//                         })
//                     );
//                     return;
//                 }

//                 const player = room.players.find((p) => p.id === playerId);
//                 if (!player) {
//                     ws.send(
//                         JSON.stringify({
//                             type: "error",
//                             message: "Player not in room",
//                         })
//                     );
//                     return;
//                 }

//                 clientRoomCode = roomCode;
//                 clientPlayerId = playerId;
//                 clientSlot = player.slot;

//                 // Register WebSocket for this player
//                 room.wsClients.set(playerId, {
//                     ws,
//                     slot: player.slot,
//                     name: player.name,
//                 });

//                 ws.send(
//                     JSON.stringify({
//                         type: "relay_joined",
//                         slot: player.slot,
//                         useRelay: room.useRelay,
//                         players: room.players.map((p) => ({
//                             slot: p.slot,
//                             name: p.name,
//                         })),
//                     })
//                 );

//                 // Notify others about new player in relay
//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         pid !== playerId &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(
//                             JSON.stringify({
//                                 type: "player_connected",
//                                 slot: player.slot,
//                                 name: player.name,
//                             })
//                         );
//                     }
//                 });

//                 console.log(
//                     `Player ${player.name} (slot ${player.slot}) connected to relay in room ${roomCode}`
//                 );
//                 break;
//             }

//             case "netplay_input": {
//                 // Relay netplay controller input to all other players
//                 if (!clientRoomCode || !rooms[clientRoomCode]) return;
//                 const room = rooms[clientRoomCode];

//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         pid !== clientPlayerId &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(
//                             JSON.stringify({
//                                 type: "netplay_input",
//                                 slot: clientSlot,
//                                 frame: msg.frame,
//                                 input: msg.input,
//                             })
//                         );
//                     }
//                 });
//                 break;
//             }

//             case "netplay_sync": {
//                 // Relay sync data (save states, etc)
//                 if (!clientRoomCode || !rooms[clientRoomCode]) return;
//                 const room = rooms[clientRoomCode];

//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         pid !== clientPlayerId &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(JSON.stringify(msg));
//                     }
//                 });
//                 break;
//             }

//             case "voice_offer":
//             case "voice_answer":
//             case "voice_ice": {
//                 // WebRTC signaling for voice chat
//                 if (!clientRoomCode || !rooms[clientRoomCode]) return;
//                 const room = rooms[clientRoomCode];

//                 const targetSlot = msg.targetSlot;

//                 // Find the target player's WebSocket
//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         client.slot === targetSlot &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(
//                             JSON.stringify({
//                                 ...msg,
//                                 fromSlot: clientSlot,
//                             })
//                         );
//                     }
//                 });
//                 break;
//             }

//             case "voice_data": {
//                 // Direct voice audio relay (fallback if WebRTC fails)
//                 if (!clientRoomCode || !rooms[clientRoomCode]) return;
//                 const room = rooms[clientRoomCode];

//                 room.wsClients.forEach((client, pid) => {
//                     if (
//                         pid !== clientPlayerId &&
//                         client.ws &&
//                         client.ws.readyState === WebSocket.OPEN
//                     ) {
//                         client.ws.send(
//                             JSON.stringify({
//                                 type: "voice_data",
//                                 fromSlot: clientSlot,
//                                 audio: msg.audio, // base64 encoded audio
//                                 timestamp: msg.timestamp,
//                             })
//                         );
//                     }
//                 });
//                 break;
//             }

//             case "ping": {
//                 ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
//                 break;
//             }

//             default:
//                 console.log("Unknown message type:", msg.type);
//         }
//     }

//     ws.on("close", () => {
//         if (clientRoomCode && rooms[clientRoomCode]) {
//             const room = rooms[clientRoomCode];
//             room.wsClients.delete(clientPlayerId);

//             // Notify other players
//             room.wsClients.forEach((client) => {
//                 if (client.ws && client.ws.readyState === WebSocket.OPEN) {
//                     client.ws.send(
//                         JSON.stringify({
//                             type: "player_disconnected",
//                             slot: clientSlot,
//                         })
//                     );
//                 }
//             });

//             console.log(
//                 `Player slot ${clientSlot} disconnected from room ${clientRoomCode}`
//             );
//         }
//     });

//     ws.on("error", (err) => {
//         console.error("WebSocket error:", err.message);
//     });
// });

// // ==========================================
// // Start server
// // ==========================================
// const PORT = process.env.PORT || 3000;
// server.listen(PORT, () => {
//     console.log(`Server running on port ${PORT}`);
//     console.log(`REST API: http://localhost:${PORT}`);
//     console.log(`WebSocket: ws://localhost:${PORT}`);
// });
