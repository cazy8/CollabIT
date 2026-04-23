# CollabIT

Real-time collaborative writing + chat + lightweight shared whiteboard, built with Node.js, Socket.IO, and a single-page vanilla frontend.

## 1. Highlights

- Real-time collaborative text editing with server-side OT conflict handling
- Live presence, join/leave events, cursor updates, and typing indicators
- Room chat with per-user identity coloring
- Embedded mini whiteboard with pen, eraser, color, brush-size, and clear
- Share flow with QR code generation and public tunnel integration

## 2. Tech Stack

### Backend

- Node.js
- Express (HTTP server + static hosting + API routes)
- Socket.IO (real-time event transport)
- LocalTunnel (optional public exposure)
- QRCode (dynamic invite QR generation)

### Frontend

- Vanilla HTML/CSS/JavaScript
- Canvas API for whiteboard rendering
- Socket.IO client for real-time syncing

### Tooling

- Nodemon (development auto-reload)
- socket.io-client (multi-user smoke testing)

## 3. Dependency Structure

### Runtime dependencies

- express: web server and static file serving
- socket.io: websocket and fallback transport layer
- qrcode: PNG QR generation for share links
- localtunnel: public temporary URL for cross-device collaboration

### Development dependencies

- nodemon: restart server automatically in development
- socket.io-client: headless test clients for smoke tests

## 4. Project Architecture

```
collab-editor/
|-- server.js
|-- package.json
|-- package-lock.json
|-- public/
|   `-- index.html
|-- scripts/
|   `-- multiuser-smoke.js
`-- screenshots/
		|-- Screenshot 2026-04-24 001110.png
		|-- Screenshot 2026-04-24 001223.png
		`-- Screenshot 2026-04-24 001254.png
```

### Runtime data model (in-memory)

- rooms[docId]
	- content: current text document
	- version: monotonic document version
	- history: OT operations history
	- users: connected user map
	- whiteboardStrokes: canvas stroke history

## 5. Installation and Setup

### Prerequisites

- Node.js 18+ recommended
- npm 9+ recommended

### Install

```bash
npm install
```

### Start (default, with tunnel attempt)

```bash
npm start
```

### Start (without tunnel)

```bash
npm start -- --no-tunnel
```

Then open:

- Local: http://localhost:3005

The app redirects `/` to a generated `/doc/<id>` room.

### Development mode

```bash
npm run dev
```

## 6. Configuration

### Environment variables

- PORT: server port (default 3005)
- DISABLE_TUNNEL: set to 1/true/yes to skip LocalTunnel
- TUNNEL_HOST: override tunnel host if needed

### CLI flags

- --no-tunnel
- --tunnel-host=<host>

## 7. Testing

Run the multi-user smoke test:

```bash
node scripts/multiuser-smoke.js
```

It validates:

- 3 clients can join the same room
- join visibility across clients
- chat propagation to all participants

## 8. Collaboration and Event Flow

### Core socket events

- join
- init
- operation + ack
- user:join / user:leave
- typing
- chat
- whiteboard:init / whiteboard:stroke / whiteboard:clear

### OT flow (text)

1. Client computes local diff operation(s)
2. Client sends operation with local version
3. Server transforms against concurrent history
4. Server applies canonical operation and increments version
5. Server broadcasts transformed operation

### Whiteboard flow

1. Client draws and emits stroke payload
2. Server validates/clamps stroke and stores in room history
3. Server broadcasts stroke to other clients
4. New joiners receive whiteboard:init snapshot

## 9. Security Notes

Current implementation prioritizes collaboration speed and demo usability. For production use, add:

- authentication and room authorization
- socket event rate limiting and payload size limits
- persistent storage and bounded history retention policies
- stricter origin/CORS policy
- security headers and reverse-proxy hardening

## 10. Screenshots

### Main Collaboration Surface

![Main collaboration UI](screenshots/Screenshot%202026-04-24%20001110.png)

### Invite and Sharing Experience

![Invite modal and sharing flow](screenshots/Screenshot%202026-04-24%20001223.png)

### Whiteboard and Collaboration Context

![Whiteboard and collaborative workspace](screenshots/Screenshot%202026-04-24%20001254.png)

## 11. Roadmap

- Document persistence (PostgreSQL/MongoDB)
- Presence heartbeats and stale-session cleanup
- Whiteboard undo/redo and shape tools
- Redis adapter for horizontal scaling
- Role-based permissions and moderated rooms
