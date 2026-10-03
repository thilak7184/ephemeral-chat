# Ephemeral Chat

A small, temporary chat room for exactly two people. Create a room, share its invite link, and chat in real time. No account or contact details are required. The browser encrypts every message before sending it; the server relays ciphertext and keeps room/session state in memory only.

> Messages are not persisted by the application and are discarded when the room ends.

Hosting providers may still retain ordinary network or operational metadata. This project does not promise that infrastructure providers store nothing.

## Features

- Secure, server-generated six-character room codes (ambiguous `0/O` and `1/I` are excluded) and cryptographic temporary session tokens.
- Exactly two participant seats, reserved during a 45-second network-reconnect grace period.
- Waiting, active and ended lifecycle states; configurable waiting and idle expiry; explicit End Chat; memory/timer cleanup.
- Live text messages and typing indicators over Socket.IO; join, leave, reconnect and connection status events.
- Browser-side AES-GCM end-to-end encryption through the Web Crypto API. Each message uses a fresh 96-bit IV; the random 256-bit room key is shared only in the URL fragment.
- Socket-side message payload validation, configurable per-session rate limit, strict CORS configuration, bounded Socket.IO payloads, Helmet headers and React's escaped text rendering.
- Per-socket room creation/join throttling and a global cap on live rooms, in addition to the message rate limit.
- Responsive accessible UI, invite-link copy with a fallback, mobile-friendly composer and keyboard support (`Enter` sends, `Shift+Enter` adds a line).
- No database, message-history API, tracking scripts or third-party font requests.

## Architecture

```text
Browser A ── React/Vite + Web Crypto ──┐
                                       ├── Socket.IO ── Express / Node.js
Browser B ── React/Vite + Web Crypto ──┘                    │
                                                            └── in-memory RoomManager
```

`client/src/crypto/chatCrypto.js` creates a random AES-GCM key in the browser and encrypts plaintext with a fresh IV for every message. The key appears after `#` in the invite URL. URL fragments are not included in ordinary HTTP requests, and the client does not send the key in Socket.IO packets. `server/src/sockets/registerSocketHandlers.js` validates encrypted payload shape/size and participant authorization, rate-limits, then relays the unchanged IV/ciphertext. Messages are never added to the room manager or written to a database or log.

The room code says which room; the random session token authorizes a participant's temporary seat. The token is stored in `sessionStorage` for page refresh recovery. The encryption key and messages are not stored in `localStorage` or `sessionStorage`.

## Privacy and security model

- Application message storage: none. Plaintext exists only in each active browser tab's memory; the server handles ciphertext only.
- End Chat, expiry and removal of all participants destroy server room/session entries and clear client message/key state. A server restart also destroys every room.
- Anyone with the complete invite URL has the room code and decryption key; share it only with the intended person. Avoid posting it publicly. Browser history/clipboard management is controlled by the browser and operating system.
- System events (join/leave/connection state) are metadata-level events, not encrypted user content.
- The application minimizes its own logs and never logs message bodies, keys or invite URLs. The deployment provider may independently log connection metadata.
- AES-GCM is provided by Web Crypto, not a custom cryptographic implementation. As with any browser application, endpoint compromise, malicious extensions, screenshots and copied plaintext are outside this app's protection.
- The server supplies the `mine` display flag and controls message delivery order. A malicious server can relabel or replay ciphertext; it cannot decrypt messages, and AES-GCM detects ciphertext modification.
- Room capacity changes occur synchronously in the Node event loop, so one server process cannot admit a third seat through simultaneous join requests.

## Requirements

- Node.js 20 or newer (tested with Node 22).
- Node.js 22 or newer.
- npm 9 or newer.
- A modern browser with Web Crypto support (localhost and HTTPS are secure contexts).

## Local setup

From the project root:

```bash
cp server/.env.example server/.env
npm install
npm run dev
```

Open <http://localhost:5173>. The Vite development server proxies `/socket.io` and `/api` to the Express server on port `5000`. You can also run the client and server separately with `npm run dev --workspace=client` and `npm run dev --workspace=server`.

Production client build and local server start:

```bash
npm run build
npm run start
```

The server exposes `GET /api/healthz`. It returns a small health response and does not expose room content.
The server serves `client/dist` with SPA route fallback when the build exists and `SERVE_CLIENT` is enabled (the default), so the commands above provide the full app at <http://localhost:5000>. To run only the API, set `SERVE_CLIENT=false`; to serve the built client with Vite instead, use `npm run preview --workspace=client`. `GET /api/healthz` returns a small health response and does not expose room content.

## Environment variables

Copy `server/.env.example` to `server/.env`. Never commit a real `.env` file.

| Variable                     | Default                 | Meaning                                                                                                                              |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                   | `development`           | Use `production` when deployed; production requires an explicit allowed origin.                                                      |
| `PORT`                       | `5000`                  | Express/Socket.IO listener port. Render provides this automatically.                                                                 |
| `CLIENT_ORIGIN`              | `http://localhost:5173` | Comma-separated exact origins allowed to use the socket/API. Do not use `*`.                                                         |
| `WAITING_ROOM_TTL_MS`        | `600000`                | Time a room may wait for a second participant before expiring.                                                                       |
| `ACTIVE_ROOM_IDLE_TTL_MS`    | `3600000`               | Inactivity period after which an active room expires. Authenticated chat activity refreshes it.                                      |
| `DISCONNECT_GRACE_MS`        | `45000`                 | How long a disconnected participant's seat is reserved.                                                                              |
| `MAX_MESSAGE_LENGTH`         | `2000`                  | Client-visible plaintext character cap and conservative server ciphertext-size bound. The server cannot inspect encrypted plaintext. |
| `MESSAGE_RATE_LIMIT`         | `10`                    | Allowed messages per session per window.                                                                                             |
| `MESSAGE_RATE_WINDOW_MS`     | `5000`                  | Sliding message-rate window.                                                                                                         |
| `ROOM_ACTION_RATE_LIMIT`     | `20`                    | Room create/join actions allowed per socket per window.                                                                              |
| `ROOM_ACTION_RATE_WINDOW_MS` | `60000`                 | Sliding room-action rate window.                                                                                                     |
| `MAX_ROOMS`                  | `1000`                  | Maximum number of live rooms held by one server process.                                                                             |
| `MAX_HTTP_BUFFER_SIZE`       | `16384`                 | Socket.IO payload ceiling in bytes.                                                                                                  |
| `HEARTBEAT_INTERVAL_MS`      | `25000`                 | Socket.IO heartbeat interval.                                                                                                        |
| `HEARTBEAT_TIMEOUT_MS`       | `20000`                 | Socket.IO heartbeat timeout.                                                                                                         |
| `MAX_CONNECTIONS`            | `500`                   | Maximum concurrent socket connections per server process.                                                                            |
| `SERVE_CLIENT`               | `true`                  | Serve `client/dist` and SPA routes from the API process when the build exists. Set to `false` for an API-only backend.               |

Client build-time variables (optional; set before `npm run build`):

| Variable                  | Default     | Meaning                                                                                                      |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `VITE_SERVER_URL`         | same origin | Public HTTPS origin of the Socket.IO backend, e.g. the Render service URL. Leave unset for local Vite proxy. |
| `VITE_MAX_MESSAGE_LENGTH` | `2000`      | UI character counter and client-side limit; keep aligned with the backend setting.                           |

## Automated tests

```bash
npm test
npm run build
npm run check
npm run test:e2e
npm audit --audit-level=high
```

The suite covers room-code validation, cryptographic room/session creation, two-seat capacity including competing joins, room expiry, active idle refresh, reconnect grace and session restoration, room destruction, rate-limit windows, AES-GCM round-trip/fresh IV/tamper rejection, and live Socket.IO create/join/full/message relay/rate-limit/reconnect/end behavior.

## Deployment

### Frontend on Vercel

1. Import the repository and set the project root to `client`.
2. Use `npm run build` as the build command and `dist` as the output directory. `client/vercel.json` rewrites deep links such as `/r/ABC123` to the SPA entry point.
3. Set `VITE_SERVER_URL` to the Render backend's public origin (for example `https://ephemeral-chat-api.onrender.com`) and optionally set `VITE_MAX_MESSAGE_LENGTH`.
4. Add the Vercel production origin as `CLIENT_ORIGIN` on Render. Add any preview origin explicitly if previews need to connect; do not replace the setting with `*`.

Changing `VITE_SERVER_URL` requires a new Vercel build because Vite embeds client variables at build time.

### Backend on Render

`render.yaml` describes a **free-tier** Node web service so deploying the sample does not silently choose a paid compute plan. Deploy from the repository root, keep the build command `npm ci`, and the start command `npm run start --workspace=server`. Set `CLIENT_ORIGIN` to the exact frontend origin in the Render environment. Render supplies `PORT`; set `NODE_ENV=production`.

Render's [Free web services](https://render.com/docs/free) are intended for testing and hobby projects, not production: they spin down after 15 minutes without inbound traffic and may restart at any time. A spin-down/restart drops all in-memory rooms and may interrupt a conversation. If always-on production availability matters, choose a paid compute plan deliberately in Render before deployment; this repository does not select one by default.

### Single-instance limitation

**In-memory rooms work correctly with one backend process/instance only.** Do not scale the Render service horizontally: different instances would have independent room maps, sessions and socket audiences. Multiple instances require shared ephemeral room/session state with atomic seat reservation, plus a Socket.IO Redis adapter (or equivalent) for cross-instance event delivery. The adapter alone does not make the room manager's in-memory capacity check shared or atomic. Any shared store should use TTL/cleanup and avoid persisting message history.
