const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// MongoDB users + email/password auth
// ==========================================
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
let usersCol = null;

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    if (!stored || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    const test = crypto.scryptSync(password, salt, 64).toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(test, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function initMongo() {
    if (!MONGO_URI) {
        console.warn("MONGO_URI not set — /login and /register are disabled");
        return;
    }
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    usersCol = client.db("yestergames").collection("users");
    await usersCol.createIndex({ email: 1 }, { unique: true });

    if ((await usersCol.countDocuments()) === 0) {
        const demo = [
            ["player1@yester.games", "play1234", "Player One"],
            ["player2@yester.games", "play1234", "Player Two"],
            ["player3@yester.games", "play1234", "Player Three"],
            ["player4@yester.games", "play1234", "Player Four"],
            ["player5@yester.games", "play1234", "Player Five"],
            ["demo@yester.games",    "demo1234", "Demo User"],
        ];
        await usersCol.insertMany(demo.map(([email, pw, name]) => ({
            email: email.toLowerCase(), name, password: hashPassword(pw), createdAt: Date.now(),
        })));
        console.log("Seeded 6 demo users");
    }
    console.log("MongoDB connected — auth ready");
}
initMongo().catch((e) => console.error("Mongo init failed:", e.message));

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

app.post("/join-room", (req, res) => {
    const { code, name } = req.body;
    const room = rooms[code];

    if (!room) return res.status(404).json({ error: "room not found" });
    if (room.players.length >= 4)
        return res.status(400).json({ error: "room full" });

    const playerId = generateId();
    const slot = room.players.length + 1;
    
    // FIX: Extract FIRST IP from x-forwarded-for header (it can be comma-separated)
    let joinerPublicIp = req.headers["x-forwarded-for"] || req.ip;
    if (joinerPublicIp && joinerPublicIp.includes(",")) {
        joinerPublicIp = joinerPublicIp.split(",")[0].trim();
    }
    // Remove IPv6 prefix if present
    if (joinerPublicIp && joinerPublicIp.startsWith("::ffff:")) {
        joinerPublicIp = joinerPublicIp.substring(7);
    }

    const player = {
        id: playerId,
        name: name || "Player",
        slot,
        publicIp: joinerPublicIp,
    };
    room.players.push(player);

    // FIX: Get host's IP the same way
    let hostPublicIp = room.players[0].publicIp;
    if (hostPublicIp && hostPublicIp.startsWith("::ffff:")) {
        hostPublicIp = hostPublicIp.substring(7);
    }

    // FIX: Better comparison - same IP = same network = LAN mode
    const sameNetwork = (hostPublicIp === joinerPublicIp);
    
    if (!sameNetwork) {
        room.useRelay = true;
        console.log(
            `Room ${code}: DIFFERENT networks detected (host=${hostPublicIp} vs joiner=${joinerPublicIp}), RELAY enabled`
        );
    } else {
        console.log(
            `Room ${code}: SAME network detected (${hostPublicIp}), LAN mode`
        );
    }

    console.log(
        `Player ${name || "Player"} joined room ${code} as slot ${slot}, useRelay=${room.useRelay}`
    );

    res.json({
        playerId,
        slot,
        hostIp: room.hostIp,
        hostPort: room.hostPort,
        useRelay: room.useRelay,
        game: room.game || "",
    });
});

app.post("/create-room", (req, res) => {
    const code = generateCode();
    const playerId = generateId();
    const { hostIp, hostPort, game } = req.body;

    // FIX: Extract FIRST IP and clean it
    let publicIp = req.headers["x-forwarded-for"] || req.ip;
    if (publicIp && publicIp.includes(",")) {
        publicIp = publicIp.split(",")[0].trim();
    }
    if (publicIp && publicIp.startsWith("::ffff:")) {
        publicIp = publicIp.substring(7);
    }

    rooms[code] = {
        code,
        hostIp: hostIp || req.ip,
        hostPort: hostPort || 45000,
        game: game || "",
        started: false,
        hostId: playerId,
        createdAt: Date.now(),
        useRelay: false,
        players: [
            {
                id: playerId,
                name: "Host",
                slot: 1,
                publicIp: publicIp,  // Use cleaned IP
            },
        ],
        wsClients: new Map(),
        gameFrames: [],
    };

    console.log(`Room ${code} created by ${playerId}, hostIp=${hostIp}, publicIp=${publicIp}`);
    res.json({
        code,
        playerId,
        hostIp: rooms[code].hostIp,
        hostPort: rooms[code].hostPort,
        game: rooms[code].game,
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
        game: room.game || "",
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
// AUTH: register + login (users in MongoDB)
// ==========================================
app.post("/register", async (req, res) => {
    try {
        if (!usersCol) return res.status(503).json({ error: "auth unavailable" });
        let { email, password, name } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: "email and password required" });
        email = String(email).trim().toLowerCase();
        if (await usersCol.findOne({ email })) return res.status(409).json({ error: "email already registered" });
        const finalName = name || email.split("@")[0];
        await usersCol.insertOne({ email, name: finalName, password: hashPassword(password), createdAt: Date.now() });
        res.json({ ok: true, email, name: finalName });
    } catch (e) {
        res.status(500).json({ error: "server error" });
    }
});

app.post("/login", async (req, res) => {
    try {
        if (!usersCol) return res.status(503).json({ error: "auth unavailable" });
        let { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: "email and password required" });
        email = String(email).trim().toLowerCase();
        const user = await usersCol.findOne({ email });
        if (!user || !verifyPassword(password, user.password)) {
            return res.status(401).json({ error: "invalid credentials" });
        }
        res.json({ ok: true, email: user.email, name: user.name });
    } catch (e) {
        res.status(500).json({ error: "server error" });
    }
});

const APK_DRIVE_ID = "15dSCOUy59Tr6bCZOhliebJNPgGk3EWWF"; // <-- update if the APK changes
const APK_DOWNLOAD_URL = `https://drive.google.com/uc?export=download&id=${APK_DRIVE_ID}`;

app.get("/download", (req, res) => res.redirect(APK_DOWNLOAD_URL));

app.get("/join/:code", (req, res) => {
    const code = String(req.params.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
    const gameId = String(req.query.g || "").replace(/[^a-z0-9-]/gi, "");
    const appUrl = "yestergames://join/" + encodeURIComponent(code) + (gameId ? "?g=" + encodeURIComponent(gameId) : "");

    // iPhone/iPad (Safari) users: the app is Android-only for now → show a "coming soon" splash.
    const ua = req.headers["user-agent"] || "";
    if (/iPhone|iPad|iPod/i.test(ua)) {
        return res.set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>YesterGames — iPhone coming soon</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#012070;color:#fff;display:flex;
       min-height:100vh;margin:0;align-items:center;justify-content:center}
  .box{text-align:center;padding:24px;max-width:360px}
  h1{font-size:24px;margin:0 0 10px;color:#FDAC00}
  p{color:#ccd7ff;font-size:16px;line-height:1.5}
</style></head><body><div class="box">
  <h1>iPhone support is coming soon</h1>
  <p>YesterGames isn't available on iPhone yet — we're working on it.
     For now, please open your invite on an Android device.</p>
</div></body></html>`);
    }

    res.set("Content-Type", "text/html").send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Join a YesterGames</title>
<style>
  body{font-family:system-ui,sans-serif;background:#012070;color:#fff;display:flex;min-height:100vh;
       margin:0;align-items:center;justify-content:center}
  .box{text-align:center;padding:24px;max-width:360px}
  h1{font-size:22px;margin:0 0 8px} p{color:#ccd7ff}
  .code{font-size:30px;letter-spacing:8px;font-weight:700;margin:14px 0}
  .btn{display:inline-block;margin-top:18px;padding:14px 28px;border-radius:10px;background:#FDAC00;
       color:#012070;font-weight:700;text-decoration:none}
</style></head><body><div class="box">
  <h1>Opening your game…</h1>
  <p>If the app doesn't open, install it, then open this link again<br/>or enter this code in the app → JOIN:</p>
  <div class="code">${code}</div>
  <a class="btn" href="/download">Download the app</a>
  <script>
    // Try to launch the installed app (no domain verification needed).
    setTimeout(function(){ window.location = ${JSON.stringify(appUrl)}; }, 100);
  </script>
</div></body></html>`);
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
let tunnel = null;

for (const code in tcpTunnels) {
    const t = tcpTunnels[code];
    if (t.hostWs === ws || t.clientWs === ws) {
        tunnel = t;
        break;
    }
}

if (tunnel && (Buffer.isBuffer(data) || data instanceof ArrayBuffer)) {

    let targetWs = null;

    if (tunnel.hostWs === ws && tunnel.clientWs) {
        targetWs = tunnel.clientWs;
    } else if (tunnel.clientWs === ws && tunnel.hostWs) {
        targetWs = tunnel.hostWs;
    }

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        console.log(`[FORWARD] ${data.length} bytes`);
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
