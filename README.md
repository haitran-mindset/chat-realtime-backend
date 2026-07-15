# WebSocket Chat – Backend

NestJS WebSocket server using **Socket.IO**, persisting messages and chat rooms with **Supabase PostgreSQL**.

## Tech stack

- **NestJS** (Node.js)
- **Socket.IO** (WebSocket)
- **PostgreSQL** (via `pg` pool)
- **TypeScript**

## Structure

```
backend/
├── src/
│   ├── main.ts              # Bootstrap, CORS, port 3001
│   ├── app.module.ts
│   └── modules/
│       └── chat/
│           ├── chat.module.ts
│           ├── chat.gateway.ts    # Socket.IO events
│           ├── chat.service.ts
│           ├── message.repository.ts   # PostgreSQL messages
│           ├── room.repository.ts      # Rooms CRUD
│           └── dto/
│               └── chat.dto.ts
├── package.json
├── tsconfig.json
└── nest-cli.json
```

## Installation

```bash
cd backend
npm install
```

## Running

- **Development** (watch mode):

  ```bash
  npm run start:dev
  ```

- **Production**:

  ```bash
  npm run build
  npm run start:prod
  ```

Server runs at **http://localhost:3001**. CORS allows frontend from `http://localhost:5173`, `http://localhost:3000`, `http://127.0.0.1:5173`.

## Database

- PostgreSQL: Configured via the `DATABASE_URL` environment variable in the `.env` file.
- Tables (`rooms` and `messages`) are automatically created on startup if they do not exist.

## WebSocket events (reference)

| Event | Direction | Description |
|-------|-----------|-------------|
| `connect` | client | Handshake (query: userId, username) |
| `message` | both | Broadcast to all |
| `batch` | client→srv | Batch multiple emits into one request (server replays handlers) |
| `private_message` | both | Private message (targetUserId) |
| `join_room` / `leave_room` | client→srv | Join / leave room |
| `room_message` | both | Message in room |
| `typing` | both | Typing indicator |
| `get_online_users` | client→srv | Request online list |
| `online_users` | srv→client | Online users list (incl. avatar) |
| `get_room_history` | client→srv | Request room history |
| `room_history` | srv→client | `{ roomId, messages }` |
| `create_room` / `rename_room` / `delete_room` | client→srv | Room management |
| `get_rooms` | client→srv | Request room list |
| `rooms_list` | srv→client | Room list update |
| `update_profile` | client→srv | Update profile (Settings) |
| `profile_updated` | srv→client | Broadcast profile update |

### Batch event details

The `batch` event accepts `{ items: [{ event, args }] }` and replays the original handlers (`message`, `room_message`, `private_message`) server-side. This reduces network overhead when clients send multiple messages in quick succession.
