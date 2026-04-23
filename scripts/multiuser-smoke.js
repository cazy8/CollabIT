const { io } = require("socket.io-client");

const target = process.argv[2] || "http://localhost:3005";
const docId = `demo-${Date.now().toString(36)}`;
const names = ["alice", "bob", "charlie"];

const sockets = [];
const state = new Map();
let initDone = 0;
let finished = false;

function shutdown(code, message) {
  if (finished) return;
  finished = true;
  if (message) {
    if (code === 0) console.log(message);
    else console.error(message);
  }
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      // ignore close errors during shutdown
    }
  }
  process.exit(code);
}

function fail(message) {
  shutdown(1, `FAIL: ${message}`);
}

for (const name of names) {
  const socket = io(target, {
    transports: ["polling"],
    timeout: 10000,
    reconnection: false,
  });

  state.set(name, {
    users: new Set(),
    chats: new Set(),
  });

  socket.on("connect_error", (err) => fail(`${name} connect_error: ${err.message}`));

  socket.on("connect", () => {
    socket.emit("join", { docId, userName: name });
  });

  socket.on("init", ({ users }) => {
    const st = state.get(name);
    for (const u of users || []) st.users.add(u.name);
    st.users.add(name);

    initDone += 1;
    if (initDone !== names.length) return;

    setTimeout(() => {
      for (const n of names) {
        if (state.get(n).users.size < 3) {
          fail(`${n} sees only ${state.get(n).users.size} users after join`);
          return;
        }
      }

      for (const n of names) {
        const s = sockets.find((x) => x.__name === n);
        s.emit("chat", { docId, message: `hello-from-${n}` });
      }

      setTimeout(() => {
        for (const n of names) {
          if (state.get(n).chats.size < 3) {
            fail(`${n} received ${state.get(n).chats.size}/3 chat messages`);
            return;
          }
        }
        shutdown(0, `PASS: 3 simultaneous users joined ${docId} and all got 3/3 chat messages.`);
      }, 1400);
    }, 1400);
  });

  socket.on("user:join", (u) => {
    if (!u || !u.name) return;
    state.get(name).users.add(u.name);
  });

  socket.on("chat", (msg) => {
    if (!msg || !msg.name) return;
    state.get(name).chats.add(msg.name);
  });

  socket.__name = name;
  sockets.push(socket);
}

setTimeout(() => fail("Timed out waiting for complete 3-user sync"), 15000);
