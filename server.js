const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const localtunnel = require("localtunnel");
const QRCode     = require("qrcode");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

// ─── Global public URL (set once tunnel is up) ────────────────────────────────
let publicUrl = null;
let tunnelPassword = null;
let tunnelInstance = null;
let tunnelStarting = false;
let tunnelRetryTimer = null;
let tunnelRetryMs = 2000;

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) {
    return process.argv[idx + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return null;
}

const TUNNEL_DISABLED =
  process.argv.includes("--no-tunnel") ||
  ["1", "true", "yes"].includes(String(process.env.DISABLE_TUNNEL || "").toLowerCase());
const TUNNEL_HOST = process.env.TUNNEL_HOST || getArgValue("--tunnel-host");

// ─── State ────────────────────────────────────────────────────────────────────
const rooms = {};

const USER_COLORS = [
  "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
  "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F"
];

function getRoom(docId) {
  if (!rooms[docId]) {
    rooms[docId] = { content: "", version: 0, history: [], users: {}, whiteboardStrokes: [] };
  }
  return rooms[docId];
}

// ─── OT helpers ───────────────────────────────────────────────────────────────
function applyOp(content, op) {
  if (op.type === "insert") return content.slice(0, op.index) + op.text + content.slice(op.index);
  if (op.type === "delete") return content.slice(0, op.index) + content.slice(op.index + op.length);
  return content;
}

function transform(op1, op2) {
  if (op1.type === "insert" && op2.type === "insert") {
    if (op1.index <= op2.index) return { ...op2, index: op2.index + op1.text.length };
  }
  if (op1.type === "delete" && op2.type === "insert") {
    if (op1.index < op2.index) return { ...op2, index: Math.max(op2.index - op1.length, op1.index) };
  }
  if (op1.type === "insert" && op2.type === "delete") {
    if (op1.index <= op2.index) return { ...op2, index: op2.index + op1.text.length };
  }
  if (op1.type === "delete" && op2.type === "delete") {
    if (op1.index < op2.index) return { ...op2, index: Math.max(op2.index - op1.length, op1.index) };
  }
  return op2;
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] ${socket.id} connected`);
  let currentDoc = null;

  socket.on("join", ({ docId, userName }) => {
    currentDoc = docId;
    socket.join(docId);
    const room = getRoom(docId);
    const colorIndex = Object.keys(room.users).length % USER_COLORS.length;
    room.users[socket.id] = {
      id: socket.id,
      name: userName || `User ${Object.keys(room.users).length + 1}`,
      color: USER_COLORS[colorIndex],
      cursor: 0
    };
    console.log(`[doc:${docId}] ${room.users[socket.id].name} joined`);
    socket.emit("init", {
      content: room.content,
      version: room.version,
      users: Object.values(room.users),
      you: room.users[socket.id],
      publicUrl,
      tunnelPassword
    });
    socket.emit("whiteboard:init", { strokes: room.whiteboardStrokes });
    socket.to(docId).emit("user:join", room.users[socket.id]);
  });

  socket.on("operation", ({ docId, op, version }) => {
    const room = getRoom(docId);
    const concurrent = room.history.slice(version);
    let xop = op;
    for (const past of concurrent) xop = transform(past, xop);
    room.content = applyOp(room.content, xop);
    room.version++;
    room.history.push(xop);
    socket.emit("ack", { version: room.version });
    socket.to(docId).emit("operation", { op: xop, version: room.version, userId: socket.id });
  });

  socket.on("cursor", ({ docId, index }) => {
    const room = getRoom(docId);
    if (room.users[socket.id]) {
      room.users[socket.id].cursor = index;
      socket.to(docId).emit("cursor", {
        userId: socket.id, index,
        color: room.users[socket.id].color,
        name:  room.users[socket.id].name
      });
    }
  });

  socket.on("selection", ({ docId, start, end }) => {
    const room = getRoom(docId);
    if (room.users[socket.id]) {
      socket.to(docId).emit("selection", {
        userId: socket.id, start, end,
        color: room.users[socket.id].color,
        name:  room.users[socket.id].name
      });
    }
  });

  socket.on("typing", ({ docId, isTyping }) => {
    const room = getRoom(docId);
    if (room.users[socket.id]) {
      socket.to(docId).emit("typing", {
        userId: socket.id, isTyping,
        name:  room.users[socket.id].name,
        color: room.users[socket.id].color
      });
    }
  });

  socket.on("chat", ({ docId, message }) => {
    const room = getRoom(docId);
    const user = room.users[socket.id];
    if (!user || !message.trim()) return;
    io.to(docId).emit("chat", {
      id: Date.now(), userId: socket.id,
      name: user.name, color: user.color,
      message: message.trim(),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    });
  });

  socket.on("whiteboard:stroke", ({ docId, stroke }) => {
    const room = getRoom(docId);
    if (!room.users[socket.id]) return;
    if (!stroke || !Array.isArray(stroke.points) || stroke.points.length < 2) return;
    const safeStroke = {
      tool: stroke.tool === "eraser" ? "eraser" : "pen",
      color: typeof stroke.color === "string" ? stroke.color.slice(0, 20) : "#c9f542",
      size: Math.max(1, Math.min(24, Number(stroke.size) || 3)),
      points: stroke.points
        .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
        .map((p) => ({ x: Math.max(0, Math.min(2000, p.x)), y: Math.max(0, Math.min(2000, p.y)) }))
    };
    if (safeStroke.points.length < 2) return;
    room.whiteboardStrokes.push(safeStroke);
    if (room.whiteboardStrokes.length > 1500) {
      room.whiteboardStrokes = room.whiteboardStrokes.slice(-1500);
    }
    socket.to(docId).emit("whiteboard:stroke", { stroke: safeStroke, userId: socket.id });
  });

  socket.on("whiteboard:clear", ({ docId }) => {
    const room = getRoom(docId);
    if (!room.users[socket.id]) return;
    room.whiteboardStrokes = [];
    io.to(docId).emit("whiteboard:clear", { userId: socket.id });
  });

  socket.on("disconnect", () => {
    if (currentDoc) {
      const room = rooms[currentDoc];
      if (room?.users[socket.id]) {
        console.log(`[-] ${room.users[socket.id].name} left doc:${currentDoc}`);
        io.to(currentDoc).emit("user:leave", { userId: socket.id });
        delete room.users[socket.id];
      }
    }
  });
});

// ─── REST: QR code image for any URL ─────────────────────────────────────────
app.get("/api/qr", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("missing url");
  try {
    const png = await QRCode.toBuffer(url, {
      width: 280, margin: 2,
      color: { dark: "#0f0f11", light: "#c9f542" }
    });
    res.set("Content-Type", "image/png").send(png);
  } catch (e) {
    res.status(500).send("qr error");
  }
});

// ─── REST: current public URL ─────────────────────────────────────────────────
app.get("/api/public-url", (req, res) => res.json({ publicUrl, tunnelPassword }));

// ─── Static ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/", (req, res) => res.redirect(`/doc/${generateId()}`));
app.get("/doc/:docId", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ─── Start ────────────────────────────────────────────────────────────────────
function generateId() { return Math.random().toString(36).slice(2, 8); }

const PORT = Number.parseInt(process.env.PORT, 10) || 3005;

function clearTunnelRetry() {
  if (tunnelRetryTimer) {
    clearTimeout(tunnelRetryTimer);
    tunnelRetryTimer = null;
  }
}

async function detectTunnelPassword() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch("https://loca.lt/mytunnelpassword", {
      signal: controller.signal,
      headers: { "user-agent": "collab-editor" }
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const raw = (await resp.text()).trim();
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(raw)) return raw;
    return null;
  } catch {
    return null;
  }
}

function broadcastPublicUrl(url, password = null) {
  publicUrl = url;
  tunnelPassword = password;
  io.emit("publicUrl", { publicUrl, tunnelPassword });
}

function scheduleTunnelRetry(reason) {
  if (TUNNEL_DISABLED) return;
  clearTunnelRetry();
  const waitMs = tunnelRetryMs;
  tunnelRetryMs = Math.min(tunnelRetryMs * 2, 60000);
  const msg = reason ? ` (${reason})` : "";
  console.warn(`\n⚠️  Tunnel down${msg}. Retrying in ${Math.round(waitMs / 1000)}s…`);
  tunnelRetryTimer = setTimeout(() => {
    startTunnel().catch(() => {
      // startTunnel already logs; avoid crashing due to timer callback.
    });
  }, waitMs);
}

async function startTunnel() {
  if (TUNNEL_DISABLED) return;
  if (tunnelStarting || tunnelInstance) return;
  tunnelStarting = true;
  try {
    const opts = { port: PORT };
    if (TUNNEL_HOST) opts.host = TUNNEL_HOST;

    const tunnel = await localtunnel(opts);
    tunnelInstance = tunnel;
    tunnelRetryMs = 2000;
    clearTunnelRetry();

    const password = await detectTunnelPassword();
    broadcastPublicUrl(tunnel.url, password);

    try {
      const qrString = await QRCode.toString(tunnel.url, { type: "terminal", small: true });
      console.log(`\n✅ Public URL (anyone on any device can use this):`);
      console.log(`\n   ${tunnel.url}\n`);
      console.log(qrString);
      console.log(`   Tip: share the full /doc/<id> link from the Invite button so everyone joins the same document.\n`);
      if (password) {
        console.log(`   loca.lt password (if prompted): ${password}\n`);
      }
    } catch {
      console.log(`\n✅ Public URL: ${tunnel.url}`);
      if (password) {
        console.log(`   loca.lt password (if prompted): ${password}`);
      }
    }

    tunnel.on("close", () => {
      if (tunnel !== tunnelInstance) return;
      tunnelInstance = null;
      broadcastPublicUrl(null);
      scheduleTunnelRetry("closed");
    });

    // localtunnel emits 'error' when the upstream tunnel server becomes unreachable.
    // If unhandled, Node treats it as an unhandled EventEmitter error and exits.
    tunnel.on("error", (err) => {
      if (tunnel !== tunnelInstance) return;
      const msg = err?.message || String(err);
      console.warn(`\n⚠️  Tunnel error: ${msg}`);
      tunnelInstance = null;
      broadcastPublicUrl(null);
      try { tunnel.close(); } catch {}
      scheduleTunnelRetry(msg);
    });
  } catch (err) {
    const msg = err?.message || String(err);
    broadcastPublicUrl(null);
    scheduleTunnelRetry(msg);
  } finally {
    tunnelStarting = false;
  }
}

server.listen(PORT, async () => {
  console.log(`\n🚀 Collab Editor  →  http://localhost:${PORT}`);
  if (TUNNEL_DISABLED) {
    console.log(`\nℹ️  Tunnel disabled. Use LAN URL (e.g. http://192.168.x.x:${PORT})`);
    console.log(`   To enable later: remove --no-tunnel (and optionally set TUNNEL_HOST).\n`);
    return;
  }

  console.log(`\n⏳ Opening public tunnel for cross-device access…`);
  if (TUNNEL_HOST) console.log(`   Using tunnel host: ${TUNNEL_HOST}`);
  await startTunnel();
});
