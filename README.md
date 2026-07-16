# WeHeyChat — Backend 🌸

NestJS WebSocket server xử lý toàn bộ logic realtime của **WeHeyChat**: chat phòng, private DM, friend system, room invitations, quản lý profile và lịch sử tin nhắn.

---

## ⚙️ Tech stack

| | |
|---|---|
| **Framework** | NestJS 10 |
| **WebSocket** | Socket.IO 4 (`@nestjs/websockets`, `@nestjs/platform-socket.io`) |
| **Database** | PostgreSQL (Supabase / Render) qua **Prisma ORM** |
| **Language** | TypeScript (strict) |
| **Port mặc định** | `3001` |

---

## 📁 Cấu trúc thư mục

```
backend/
├── src/
│   ├── main.ts                      # Bootstrap, CORS, port config
│   ├── app.module.ts
│   ├── prisma/
│   │   └── prisma.service.ts        # PrismaClient singleton (injectable)
│   └── modules/
│       └── chat/
│           ├── chat.module.ts
│           ├── chat.gateway.ts      # Toàn bộ Socket.IO event handlers
│           ├── chat.service.ts      # Business logic (connect, disconnect...)
│           ├── message.repository.ts    # CRUD messages
│           ├── room.repository.ts       # CRUD rooms + membership + invitations
│           ├── friendship.repository.ts # Friend requests + friend list
│           ├── profile.repository.ts    # User profiles
│           └── dto/
│               └── chat.dto.ts
├── prisma/
│   └── schema.prisma                # Database schema
├── .env.example
├── package.json
├── tsconfig.json
└── nest-cli.json
```

---

## 🗄️ Database schema (Prisma)

```
Profile         — User account: email, username, avatar, bio, role (USER / ADMIN)
Room            — Chat room: name, createdBy, isPrivate
RoomMember      — Quan hệ Profile ↔ Room (joinedAt)
Message         — Tin nhắn room hoặc private (roomId / targetUserId)
Friendship      — Friend request: userId, friendId, status (PENDING / ACCEPTED)
RoomInvitation  — Room invite: roomId, inviteeId, inviterId, status (PENDING / ACCEPTED / DECLINED)
```

Xem chi tiết: [`prisma/schema.prisma`](./prisma/schema.prisma)

---

## ⚙️ Cài đặt & chạy

### 1. Cài dependencies

```bash
npm install
```

### 2. Tạo file `.env`

```bash
cp .env.example .env
```

Cấu hình các biến:

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

### 3. Chạy migration

```bash
npx prisma migrate dev
```

### 4. Khởi động server

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run build
npm run start:prod
```

Server khởi động tại **http://localhost:3001**.

---

## 🌐 Socket.IO events

### Client → Server

| Event | Payload | Mô tả |
|---|---|---|
| `join_room` | `{ roomId }` | Vào phòng chat |
| `leave_room` | `{ roomId }` | Rời phòng chat |
| `room_message` | `{ roomId, message }` | Gửi tin nhắn vào phòng |
| `private_message` | `{ targetUserId, message }` | Gửi tin nhắn riêng tư |
| `typing` | `{ roomId?, isTyping }` | Đang nhập |
| `get_online_users` | — | Lấy danh sách user online |
| `get_room_history` | `{ roomId }` | Lấy 50 tin nhắn gần nhất |
| `create_room` | `{ roomName, isPrivate? }` | Tạo phòng mới |
| `rename_room` | `{ roomId, newName }` | Đổi tên phòng (owner) |
| `delete_room` | `{ roomId }` | Xóa phòng (owner) |
| `invite_to_room` | `{ roomId, targetUserId }` | Mời bạn vào phòng |
| `respond_room_invite` | `{ roomId, accept: boolean }` | Chấp nhận / từ chối invite |
| `get_room_members` | `{ roomId }` | Lấy danh sách thành viên |
| `kick_member` | `{ roomId, targetUserId }` | Xóa thành viên (owner) |
| `exit_room` | `{ roomId }` | Rời phòng (non-owner) |
| `send_friend_request` | `{ targetUserId }` | Gửi lời mời kết bạn |
| `respond_friend_request` | `{ targetUserId, action }` | `"accept"` hoặc `"decline"` |
| `remove_friend` | `{ targetUserId }` | Hủy kết bạn |
| `update_profile` | `{ userId, username, avatar, bio? }` | Cập nhật profile |
| `clear_room_history` | `{ roomId }` | Xóa lịch sử (Admin only) |

### Server → Client

| Event | Payload | Mô tả |
|---|---|---|
| `online_users` | `OnlineUser[]` | Danh sách user đang online |
| `rooms_list` | `RoomListItem[]` | Danh sách phòng (broadcast khi có thay đổi) |
| `room_history` | `{ roomId, messages }` | Lịch sử tin nhắn |
| `room_members` | `{ roomId, members }` | Thành viên phòng |
| `room_created` | `{ roomId, roomName, createdBy }` | Phòng mới được tạo |
| `room_renamed` | `{ roomId, oldName, newName }` | Phòng được đổi tên |
| `room_deleted` | `{ roomId, roomName }` | Phòng bị xóa |
| `room_invite` | `{ roomId, roomName, inviterUsername, createdAt }` | Nhận được lời mời vào phòng |
| `user_joined_room` | `{ username, roomId }` | Có người vào phòng |
| `user_left_room` | `{ username, roomId }` | Có người rời phòng |
| `moved_to_general` | — | Bị chuyển về #general (phòng bị xóa) |
| `friend_request_received` | `{ from }` | Nhận lời mời kết bạn |
| `friend_request_responded` | `{ action, by }` | Phản hồi lời mời kết bạn |
| `friend_removed` | `{ by }` | Bị hủy kết bạn |
| `profile_updated` | `{ userId, username, avatar, bio? }` | Profile được cập nhật |
| `room_error` | `{ action, message }` | Lỗi validation |

---

## 🔐 CORS

CORS được cấu hình qua biến `CORS_ORIGIN` trong `.env`. Mặc định cho phép `http://localhost:5173`.
