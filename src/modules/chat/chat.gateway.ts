import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { ChatService } from './chat.service';
import {
  ChatMessagePayload,
  TypingPayload,
  JoinRoomPayload,
  StoredMessage,
} from './dto/chat.dto';
import { MessageRepository } from './message.repository';
import { RoomRepository } from './room.repository';
import { ProfileRepository } from './profile.repository';
import { FriendshipRepository } from './friendship.repository';

type BatchItem = {
  event: 'message' | 'room_message' | 'private_message';
  args: unknown[];
};
type BatchPayload = { items: BatchItem[] };

/**
 * WebSocket Gateway: handles all Socket.IO events.
 * Namespace: default (/).
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
      : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
    credentials: true,
  },
  namespace: '/',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly messageRepository: MessageRepository,
    private readonly roomRepository: RoomRepository,
    private readonly profileRepository: ProfileRepository,
    private readonly friendshipRepository: FriendshipRepository,
  ) {}

  /**
   * Safely retrieves a socket instance by its ID.
   * Handles cases where this.server is either a Server or Namespace instance,
   * protecting against 'Cannot read properties of undefined (reading "get")' errors.
   */
  private getSocket(socketId: string): Socket | undefined {
    if (!this.server) return undefined;

    // Check if this.server.sockets is directly a Map (Namespace pattern in socket.io v4)
    if (this.server.sockets instanceof Map) {
      return this.server.sockets.get(socketId) as Socket | undefined;
    }

    // Check if this.server.sockets has a nested .sockets Map (Server pattern in socket.io v4)
    const nestedSockets = (this.server.sockets as any)?.sockets;
    if (nestedSockets instanceof Map) {
      return nestedSockets.get(socketId) as Socket | undefined;
    }

    // Fallback using namespace lookup
    if (typeof this.server.of === 'function') {
      try {
        const ns = this.server.of('/');
        if (ns && ns.sockets instanceof Map) {
          return ns.sockets.get(socketId) as Socket | undefined;
        }
      } catch (err) {
        this.logger.debug(`Error resolving socket in fallback namespace: ${err}`);
      }
    }

    // Fallback for Socket.io v2 where sockets were stored in connected object
    const connected = (this.server.sockets as any)?.connected;
    if (connected && typeof connected === 'object') {
      return connected[socketId] as Socket | undefined;
    }

    return undefined;
  }


  async emitFriendships(userId: string, socketId?: string) {
    const list = await this.friendshipRepository.getFriendships(userId);
    const onlineUsers = this.chatService.getOnlineUsers();
    const onlineUserIds = new Set(onlineUsers.map((u) => u.userId));

    const friendsWithStatus = list.friends.map((f) => ({
      ...f,
      status: onlineUserIds.has(f.userId) ? 'ONLINE' : 'OFFLINE',
    }));

    const target = socketId || this.chatService.getSocketIdByUserId(userId);
    if (target) {
      this.server.to(target).emit('friends_list', {
        friends: friendsWithStatus,
        pendingSent: list.pendingSent,
        pendingReceived: list.pendingReceived,
      });
    }
  }

  async broadcastFriendsStatus(userId: string) {
    try {
      const list = await this.friendshipRepository.getFriendships(userId);
      for (const friend of list.friends) {
        const socketId = this.chatService.getSocketIdByUserId(friend.userId);
        if (socketId) {
          await this.emitFriendships(friend.userId, socketId);
        }
      }
    } catch (err) {
      this.logger.error(`Error broadcasting friends status: ${err}`);
    }
  }

  /**
   * Client connected: expect handshake with userId and username.
   */
  async handleConnection(client: Socket) {
    const userId = client.handshake.query?.userId as string | undefined;
    const username = client.handshake.query?.username as string | undefined;
    const avatar = (client.handshake.query?.avatar as string) || '';
    const email = (client.handshake.query?.email as string) || '';

    if (!userId || !username) {
      this.logger.warn(`Connection rejected: missing userId or username. Socket: ${client.id}`);
      return;
    }

    try {
      // 1. Sync user profile in database
      await this.profileRepository.upsertProfile(userId, email, username, avatar);

      // 2. Fetch user's persistent rooms from database
      const joinedRooms = await this.roomRepository.getRoomsJoinedByUser(userId);
      const generalId = RoomRepository.getGeneralRoomId();

      // Ensure they belong to general room in database
      if (!joinedRooms.includes(generalId)) {
        await this.roomRepository.joinRoom(userId, generalId);
        joinedRooms.push(generalId);
      }

      // 3. Register user in-memory
      this.chatService.addUser(client.id, userId, username, avatar);

      // 4. Socket join all persistent rooms
      for (const roomId of joinedRooms) {
        client.join(roomId);
        this.chatService.joinRoom(client.id, roomId);
      }

      // 5. Emit the user's role back to them
      const role = await this.profileRepository.getRole(userId);
      client.emit('my_role', { role });

      this.logger.log(`User connected: ${username} (${userId}) [${client.id}] role=${role}`);
      this.broadcastOnlineUsers();

      // 6. Push the personalised room list (always includes General) to this user
      await this.emitRoomsToUser(userId, client.id);

      // Emit friendship lists and alert friends
      await this.emitFriendships(userId, client.id);
      await this.broadcastFriendsStatus(userId);
    } catch (err) {
      this.logger.error(`Error in handleConnection: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Client disconnected: cleanup and notify.
   */
  async handleDisconnect(client: { id: string }) {
    const user = this.chatService.removeUser(client.id);
    if (user) {
      this.logger.log(`User disconnected: ${user.username} [${client.id}]`);
      this.broadcastOnlineUsers();
      await this.broadcastFriendsStatus(user.userId);
    }
  }


  /**
   * Broadcast message to all connected clients.
   */
  @SubscribeMessage('message')
  async handleMessage(
    client: { id: string },
    payload: ChatMessagePayload,
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const now = Date.now();
    const id = `msg-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const avatar = payload.avatar ?? user.avatar ?? '';

    const stored: StoredMessage = {
      id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: 'general',
      timestamp: now,
    };
    await this.messageRepository.save(stored);

    const data = {
      id: stored.id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: 'general',
      timestamp: now,
    };
    this.logger.debug(`Broadcast message from ${user.username}: ${payload.message}`);
    this.server.emit('message', data);
  }

  /**
   * Batch multiple client→server events into a single request to reduce network overhead.
   * Each item replays the original handler with the same socket client context.
   */
  @SubscribeMessage('batch')
  async handleBatch(
    client: { id: string },
    payload: BatchPayload,
  ) {
    if (!payload?.items || !Array.isArray(payload.items)) return;

    for (const item of payload.items) {
      if (!item || typeof item !== 'object') continue;
      const event = (item as BatchItem).event;
      const args = Array.isArray((item as BatchItem).args) ? (item as BatchItem).args : [];
      const first = args[0];

      if (!event || typeof event !== 'string') continue;

      if (event === 'message' && first) {
        await this.handleMessage(client, first as ChatMessagePayload);
        continue;
      }

      if (event === 'room_message' && first) {
        await this.handleRoomMessage(client, first as ChatMessagePayload);
        continue;
      }

      if (event === 'private_message' && first) {
        this.handlePrivateMessage(client, first as ChatMessagePayload & { targetUserId: string });
        continue;
      }
    }
  }

  /**
   * Private message: send to a specific user by userId.
   */
  @SubscribeMessage('private_message')
  async handlePrivateMessage(
    client: { id: string },
    payload: ChatMessagePayload & { targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const now = Date.now();
    const id = `msg-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const avatar = payload.avatar ?? user.avatar ?? '';
    
    const stored: StoredMessage = {
      id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: null,
      targetUserId: payload.targetUserId,
      timestamp: now,
    };
    await this.messageRepository.save(stored);

    const targetSocketId = this.chatService.getSocketIdByUserId(payload.targetUserId);
    const data = {
      id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: null,
      targetUserId: payload.targetUserId,
      timestamp: now,
    };

    // Emit to sender
    this.server.to(client.id).emit('private_message', data);

    // Emit to recipient if online
    if (targetSocketId && targetSocketId !== client.id) {
      this.server.to(targetSocketId).emit('private_message', data);
      this.logger.debug(`Private message ${user.username} -> ${payload.targetUserId}`);
    }
  }

  /**
   * Load private message history between current user and target user.
   */
  @SubscribeMessage('get_private_history')
  async handleGetPrivateHistory(
    client: { id: string },
    payload: { targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.targetUserId) return;

    const messages = await this.messageRepository.getPrivateHistory(
      user.userId,
      payload.targetUserId,
    );
    this.server.to(client.id).emit('private_history', {
      targetUserId: payload.targetUserId,
      messages,
    });
  }

  /**
   * Send a friend request.
   */
  @SubscribeMessage('send_friend_request')
  async handleSendFriendRequest(
    client: { id: string },
    payload: { targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.targetUserId) return;

    try {
      await this.friendshipRepository.sendRequest(user.userId, payload.targetUserId);
      this.logger.log(`Friend request sent: ${user.userId} -> ${payload.targetUserId}`);

      // Notify recipient if online
      const targetSocketId = this.chatService.getSocketIdByUserId(payload.targetUserId);
      if (targetSocketId) {
        this.server.to(targetSocketId).emit('friend_request_received', {
          userId: user.userId,
          username: user.username,
          avatar: user.avatar,
        });
      }

      // Update lists for both
      await this.emitFriendships(user.userId);
      await this.emitFriendships(payload.targetUserId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send friend request';
      this.server.to(client.id).emit('room_error', { action: 'friend_request', message });
    }
  }

  /**
   * Accept or decline an incoming friend request.
   */
  @SubscribeMessage('respond_to_friend_request')
  async handleRespondToFriendRequest(
    client: { id: string },
    payload: { targetUserId: string; action: 'accept' | 'decline' },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.targetUserId) return;

    try {
      const accept = payload.action === 'accept';
      // In DB, targetUserId is the sender of the request, and user.userId is the recipient.
      await this.friendshipRepository.respondToRequest(payload.targetUserId, user.userId, accept);
      this.logger.log(`Friend request response: ${user.userId} ${payload.action}ed ${payload.targetUserId}`);

      if (accept) {
        const targetSocketId = this.chatService.getSocketIdByUserId(payload.targetUserId);
        if (targetSocketId) {
          this.server.to(targetSocketId).emit('friend_request_accepted', {
            userId: user.userId,
            username: user.username,
          });
        }
      }

      // Update lists for both
      await this.emitFriendships(user.userId);
      await this.emitFriendships(payload.targetUserId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to respond to friend request';
      this.server.to(client.id).emit('room_error', { action: 'friend_response', message });
    }
  }

  /**
   * Remove/delete an existing friendship.
   */
  @SubscribeMessage('remove_friend')
  async handleRemoveFriend(
    client: { id: string },
    payload: { targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.targetUserId) return;

    try {
      await this.friendshipRepository.removeFriend(user.userId, payload.targetUserId);
      this.logger.log(`Friend removed: ${user.userId} <-> ${payload.targetUserId}`);

      // Update lists for both
      await this.emitFriendships(user.userId);
      await this.emitFriendships(payload.targetUserId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove friend';
      this.server.to(client.id).emit('room_error', { action: 'remove_friend', message });
    }
  }

  /**
   * Get friend lists for current user.
   */
  @SubscribeMessage('get_friends')
  async handleGetFriends(client: { id: string }) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;
    await this.emitFriendships(user.userId, client.id);
  }


  /**
   * Join a room. Room must exist (general or in repository).
   * - General room: always accessible to all authenticated users.
   * - Private rooms: user must already be a DB member (invited by owner).
   */
  @SubscribeMessage('join_room')
  async handleJoinRoom(
    client: { id: string; join: (room: string) => void },
    payload: JoinRoomPayload,
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const roomId = payload.roomId || 'general';
    const generalId = RoomRepository.getGeneralRoomId();

    // General room: always allow
    if (roomId !== generalId) {
      const room = await this.roomRepository.getById(roomId);
      if (!room) {
        this.server.to(client.id).emit('room_error', { action: 'join', message: 'Room not found' });
        return;
      }

      // Private room: only members (invited) can join
      const isMember = await this.roomRepository.isMember(roomId, user.userId);
      if (!isMember) {
        this.server.to(client.id).emit('room_error', {
          action: 'join',
          message: 'You are not a member of this private room',
        });
        return;
      }
    }

    client.join(roomId);
    this.chatService.joinRoom(client.id, roomId);
    await this.roomRepository.joinRoom(user.userId, roomId);

    const data = {
      userId: user.userId,
      username: user.username,
      roomId,
      timestamp: new Date().toISOString(),
    };
    this.server.to(roomId).emit('user_joined_room', data);
    this.logger.log(`${user.username} joined room: ${roomId}`);
  }

  /**
   * Leave a room in-memory (channel unsubscribe during UI navigation).
   * Does NOT remove permanent DB membership.
   */
  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    client: { id: string; leave: (room: string) => void },
    payload: { roomId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const roomId = payload.roomId || 'general';
    client.leave(roomId);
    const wasInRoom = this.chatService.leaveRoom(client.id, roomId);

    if (!wasInRoom) {
      this.logger.log(`${user.username} switched away from room: ${roomId} (was not in room, skipping broadcast)`);
      return;
    }

    const data = {
      userId: user.userId,
      username: user.username,
      roomId,
      timestamp: new Date().toISOString(),
    };
    this.server.to(roomId).emit('user_left_room', data);
    this.logger.log(`${user.username} switched away from room: ${roomId}`);
  }

  /**
   * Leave a room permanently (remove from DB membership).
   * General room cannot be left.
   */
  @SubscribeMessage('exit_room')
  async handleExitRoom(
    client: { id: string; leave: (room: string) => void },
    payload: { roomId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.roomId) return;

    const roomId = payload.roomId;
    const generalId = RoomRepository.getGeneralRoomId();

    if (roomId === generalId) {
      this.server.to(client.id).emit('room_error', { action: 'exit', message: 'Cannot leave general room' });
      return;
    }

    // 1. UPDATE IN-MEMORY STATE IMMEDIATELY to prevent race conditions from concurrent leave_room events
    const wasInRoom = this.chatService.leaveRoom(client.id, roomId);
    client.leave(roomId);

    try {
      const isMember = await this.roomRepository.isMember(roomId, user.userId);
      if (!isMember) {
        this.server.to(client.id).emit('room_error', { action: 'exit', message: 'You are not a member of this room' });
        return;
      }

      // Remove from DB membership
      await this.roomRepository.leaveRoom(user.userId, roomId);

      this.logger.log(`${user.username} left room permanently: ${roomId}`);

      // Notify others in room only if they were in the room in memory
      if (wasInRoom) {
        const data = {
          userId: user.userId,
          username: user.username,
          roomId,
          timestamp: new Date().toISOString(),
        };
        this.server.to(roomId).emit('user_left_room', data);
      }

      // Send updated room list to user
      await this.emitRoomsToUser(user.userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to leave room';
      this.server.to(client.id).emit('room_error', { action: 'exit', message });
    }
  }

  /**
   * Kick/remove a member from a private room.
   * Only the room owner can perform this action.
   */
  @SubscribeMessage('kick_member')
  async handleKickMember(
    client: { id: string },
    payload: { roomId: string; targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.roomId || !payload.targetUserId) return;

    const roomId = payload.roomId;
    const targetUserId = payload.targetUserId;
    const generalId = RoomRepository.getGeneralRoomId();

    if (roomId === generalId) {
      this.server.to(client.id).emit('room_error', { action: 'kick', message: 'Cannot kick from general room' });
      return;
    }

    try {
      // 1. Verify caller is owner
      const isOwner = await this.roomRepository.isOwner(roomId, user.userId);
      if (!isOwner) {
        this.server.to(client.id).emit('room_error', { action: 'kick', message: 'Only the room owner can kick members' });
        return;
      }

      // 2. Verify target is a member
      const isMember = await this.roomRepository.isMember(roomId, targetUserId);
      if (!isMember) {
        this.server.to(client.id).emit('room_error', { action: 'kick', message: 'User is not a member of this room' });
        return;
      }

      // 3. Remove target from DB membership
      await this.roomRepository.leaveRoom(targetUserId, roomId);

      // 4. Force leave socket if target is online
      const targetSocketId = this.chatService.getSocketIdByUserId(targetUserId);
      if (targetSocketId) {
        const targetSocket = this.getSocket(targetSocketId);
        if (targetSocket) {
          targetSocket.leave(roomId);
          targetSocket.join(generalId);
          this.chatService.leaveRoom(targetSocketId, roomId);
          this.chatService.joinRoom(targetSocketId, generalId);
          targetSocket.emit('moved_to_general', { roomId, reason: 'kick' });
        }
        // Send updated room list to target user
        await this.emitRoomsToUser(targetUserId);
      }

      this.logger.log(`${user.username} kicked ${targetUserId} from room ${roomId}`);

      // Broadcast to room
      this.server.to(roomId).emit('user_kicked_from_room', {
        roomId,
        userId: targetUserId,
        kickedBy: user.username,
      });

      // Send updated members list back to the owner's client immediately
      const updatedMembers = await this.roomRepository.getRoomMembers(roomId);
      this.server.to(client.id).emit('room_members', {
        roomId,
        members: updatedMembers,
      });

      // Send updated room list to owner
      await this.emitRoomsToUser(user.userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to kick member';
      this.server.to(client.id).emit('room_error', { action: 'kick', message });
    }
  }

  /**
   * Fetch detailed list of members in a room.
   */
  @SubscribeMessage('get_room_members')
  async handleGetRoomMembers(
    client: { id: string },
    payload: { roomId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.roomId) return;

    try {
      const isMember = await this.roomRepository.isMember(payload.roomId, user.userId);
      if (!isMember) {
        this.server.to(client.id).emit('room_error', { action: 'members', message: 'You are not a member of this room' });
        return;
      }

      const members = await this.roomRepository.getRoomMembers(payload.roomId);
      this.server.to(client.id).emit('room_members', {
        roomId: payload.roomId,
        members,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get room members';
      this.server.to(client.id).emit('room_error', { action: 'members', message });
    }
  }

  /**
   * Room chat: message to a specific room.
   */
  @SubscribeMessage('room_message')
  async handleRoomMessage(
    client: { id: string },
    payload: ChatMessagePayload,
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.roomId) return;

    const now = Date.now();
    const id = `msg-${now}-${Math.random().toString(36).slice(2, 9)}`;
    const avatar = payload.avatar ?? user.avatar ?? '';

    const stored: StoredMessage = {
      id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: payload.roomId,
      timestamp: now,
    };
    await this.messageRepository.save(stored);

    const data = {
      id: stored.id,
      userId: user.userId,
      username: user.username,
      avatar,
      message: payload.message,
      roomId: payload.roomId,
      timestamp: now,
    };
    this.server.to(payload.roomId).emit('room_message', data);
    this.logger.debug(`Room message in ${payload.roomId} from ${user.username}`);
  }

  /**
   * Typing indicator: broadcast to room or to target user for private.
   */
  @SubscribeMessage('typing')
  handleTyping(client: { id: string }, payload: TypingPayload) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const data = {
      userId: user.userId,
      username: user.username,
      roomId: payload.roomId,
      isTyping: payload.isTyping,
    };

    if (payload.roomId) {
      this.server.to(payload.roomId).emit('typing', data);
    } else {
      this.server.emit('typing', data);
    }
  }

  /**
   * Client requests current online users list.
   */
  @SubscribeMessage('get_online_users')
  handleGetOnlineUsers(client: { id: string }) {
    const users = this.chatService.getOnlineUsers();
    this.server.to(client.id).emit('online_users', users);
  }

  /**
   * Client requests last 50 messages for a room.
   * General room: accessible to all. Private rooms: membership required.
   */
  @SubscribeMessage('get_room_history')
  async handleGetRoomHistory(
    client: { id: string },
    payload: { roomId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const roomId = payload.roomId || 'general';
    const generalId = RoomRepository.getGeneralRoomId();

    // For non-General rooms, verify membership
    if (roomId !== generalId) {
      const isMember = await this.roomRepository.isMember(roomId, user.userId);
      if (!isMember) {
        this.server.to(client.id).emit('room_error', {
          action: 'history',
          message: 'You are not a member of this room',
        });
        return;
      }
    }

    const messages = await this.messageRepository.getLast50ByRoom(roomId);
    this.server.to(client.id).emit('room_history', { roomId, messages });
    this.logger.debug(`Sent ${messages.length} history messages for room ${roomId} to ${client.id}`);
  }

  /**
   * Emit current online users to all clients.
   */
  private broadcastOnlineUsers() {
    const users = this.chatService.getOnlineUsers();
    this.server.emit('online_users', users);
  }

  /**
   * Emit the personalised room list to a single user by userId.
   * Can target a specific socketId or fallback to all active sockets for that user.
   */
  private async emitRoomsToUser(userId: string, socketId?: string) {
    const rooms = await this.roomRepository.getAllForUser(userId);
    if (socketId) {
      this.server.to(socketId).emit('rooms_list', rooms);
      return;
    }
    const socketIds = this.chatService.getSocketIdsByUserId(userId);
    for (const sid of socketIds) {
      this.server.to(sid).emit('rooms_list', rooms);
    }
  }

  /**
   * Emit personalised room list to all currently connected users.
   */
  private async broadcastRoomsToAll() {
    const onlineUsers = this.chatService.getOnlineUsers();
    await Promise.all(onlineUsers.map((u) => this.emitRoomsToUser(u.userId)));
  }

  /**
   * Create a new room. Room name must be unique. Broadcasts updated room list to all.
   */
  @SubscribeMessage('create_room')
  async handleCreateRoom(
    client: { id: string },
    payload: { roomName: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    try {
      const room = await this.roomRepository.create(
        payload.roomName?.trim() || '',
        user.userId,
      );
      this.logger.log(`Room created: ${room.name} (${room.id}) by ${user.username}`);

      // Auto socket-join creator into the room
      const creatorSocket = this.getSocket(client.id);
      if (creatorSocket) {
        creatorSocket.join(room.id);
        this.chatService.joinRoom(client.id, room.id);
      }

      // Notify creator only (private room)
      this.server.to(client.id).emit('room_created', {
        roomId: room.id,
        roomName: room.name,
        createdBy: user.username,
      });
      // Refresh only creator's room list
      await this.emitRoomsToUser(user.userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create room';
      this.server.to(client.id).emit('room_error', { action: 'create', message });
    }
  }

  /**
   * Rename an existing room. General cannot be renamed. Broadcasts updated room list.
   */
  @SubscribeMessage('rename_room')
  async handleRenameRoom(
    client: { id: string },
    payload: { roomId: string; newName: string },
  ) {
    if (!payload.roomId || !payload.newName?.trim()) return;

    try {
      const existing = await this.roomRepository.getById(payload.roomId);
      if (!existing) throw new Error('Room not found');
      const oldName = existing.name;
      await this.roomRepository.rename(payload.roomId, payload.newName.trim());
      this.logger.log(`Room renamed: ${payload.roomId} -> ${payload.newName}`);
      // Notify members of the room only
      this.server.to(payload.roomId).emit('room_renamed', {
        roomId: payload.roomId,
        oldName,
        newName: payload.newName.trim(),
      });
      // Refresh room list for all members
      const memberIds = await this.roomRepository.getRoomMemberIds(payload.roomId);
      await Promise.all(memberIds.map((uid) => this.emitRoomsToUser(uid)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to rename room';
      this.server.to(client.id).emit('room_error', { action: 'rename', message });
    }
  }

  /**
   * Delete a room. General cannot be deleted. Users in the room are moved to general.
   */
  @SubscribeMessage('delete_room')
  async handleDeleteRoom(
    client: { id: string },
    payload: { roomId: string },
  ) {
    const roomId = payload.roomId;
    if (!roomId) return;

    try {
      if (roomId === RoomRepository.getGeneralRoomId()) {
        this.server.to(client.id).emit('room_error', { action: 'delete', message: 'Cannot delete general room' });
        return;
      }

      const room = await this.roomRepository.getById(roomId);
      if (!room) throw new Error('Room not found');
      const roomName = room.name;
      const user = this.chatService.getUserBySocketId(client.id);
      const deletedBy = user?.username ?? 'Unknown';

      const memberIds = await this.roomRepository.getRoomMemberIds(roomId);

      const socketIds = this.chatService.getRoomMemberSocketIds(roomId);
      const generalId = RoomRepository.getGeneralRoomId();

      for (const socketId of socketIds) {
        const socket = this.getSocket(socketId);
        if (socket) {
          socket.leave(roomId);
          socket.join(generalId);
          this.chatService.leaveRoom(socketId, roomId);
          this.chatService.joinRoom(socketId, generalId);
          socket.emit('moved_to_general', { roomId, reason: 'delete' });
        }
      }

      await this.roomRepository.delete(roomId);
      this.logger.log(`Room deleted: ${roomId}`);
      // Notify only members who were in the room
      this.server.to(generalId).emit('room_deleted', { roomId, roomName, deletedBy });
      // Refresh room list for affected users
      await Promise.all(memberIds.map((uid) => this.emitRoomsToUser(uid)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete room';
      this.server.to(client.id).emit('room_error', { action: 'delete', message });
    }
  }

  /**
   * Client requests their personalised room list.
   */
  @SubscribeMessage('get_rooms')
  async handleGetRooms(client: { id: string }) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;
    const rooms = await this.roomRepository.getAllForUser(user.userId);
    this.server.to(client.id).emit('rooms_list', rooms);
  }

  /**
   * Invite a user to a private room. Only the room owner can invite.
   */
  @SubscribeMessage('invite_to_room')
  async handleInviteToRoom(
    client: { id: string },
    payload: { roomId: string; targetUserId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user || !payload.roomId || !payload.targetUserId) return;

    try {
      // Only owner can invite
      const isOwner = await this.roomRepository.isOwner(payload.roomId, user.userId);
      if (!isOwner) {
        this.server.to(client.id).emit('room_error', {
          action: 'invite',
          message: 'Only the room owner can invite users',
        });
        return;
      }

      // Check not already a member
      const alreadyMember = await this.roomRepository.isMember(payload.roomId, payload.targetUserId);
      if (alreadyMember) {
        this.server.to(client.id).emit('room_error', {
          action: 'invite',
          message: 'User is already a member of this room',
        });
        return;
      }

      const room = await this.roomRepository.getById(payload.roomId);
      if (!room) throw new Error('Room not found');

      // Add target user to DB membership
      await this.roomRepository.joinRoom(payload.targetUserId, payload.roomId);

      // Socket-join target user if online
      const targetSocketId = this.chatService.getSocketIdByUserId(payload.targetUserId);
      if (targetSocketId) {
        const targetSocket = this.getSocket(targetSocketId);
        if (targetSocket) {
          targetSocket.join(payload.roomId);
          this.chatService.joinRoom(targetSocketId, payload.roomId);
        }
        // Notify invited user
        this.server.to(targetSocketId).emit('room_invite_received', {
          roomId: payload.roomId,
          roomName: room.name,
          invitedBy: user.username,
        });
        // Send updated room list to invited user
        await this.emitRoomsToUser(payload.targetUserId);
      }

      this.logger.log(`${user.username} invited ${payload.targetUserId} to room ${payload.roomId}`);
      this.server.to(client.id).emit('room_invite_sent', {
        roomId: payload.roomId,
        targetUserId: payload.targetUserId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to invite user';
      this.server.to(client.id).emit('room_error', { action: 'invite', message });
    }
  }

  @SubscribeMessage('update_profile')
  async handleUpdateProfile(
    client: { id: string },
    payload: { username: string; avatar: string; bio?: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    user.username = payload.username;
    user.avatar = payload.avatar;

    await this.profileRepository.updateProfile(
      user.userId,
      payload.username,
      payload.avatar,
      payload.bio ?? '',
    );

    this.server.emit('profile_updated', {
      userId: user.userId,
      username: payload.username,
      avatar: payload.avatar,
      bio: payload.bio ?? '',
    });

    this.broadcastOnlineUsers();
  }

  /**
   * Clear all chat history in a room. Only ADMIN can perform this action.
   * Currently restricted to the General channel only.
   */
  @SubscribeMessage('clear_room_history')
  async handleClearRoomHistory(
    client: { id: string },
    payload: { roomId: string },
  ) {
    const user = this.chatService.getUserBySocketId(client.id);
    if (!user) return;

    const roomId = payload?.roomId || RoomRepository.getGeneralRoomId();

    // Only allow clearing the General channel
    if (roomId !== RoomRepository.getGeneralRoomId()) {
      this.server.to(client.id).emit('room_error', {
        action: 'clear_history',
        message: 'Can only clear the General channel history',
      });
      return;
    }

    // Check ADMIN role from DB
    const role = await this.profileRepository.getRole(user.userId);
    if (role !== 'ADMIN') {
      this.server.to(client.id).emit('room_error', {
        action: 'clear_history',
        message: 'Permission denied: ADMIN role required',
      });
      return;
    }

    try {
      const count = await this.messageRepository.deleteAllByRoom(roomId);
      this.logger.log(
        `Room history cleared: ${roomId} (${count} messages) by ${user.username}`,
      );
      // Broadcast to ALL clients so everyone's UI clears
      this.server.emit('room_history_cleared', { roomId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear history';
      this.server.to(client.id).emit('room_error', { action: 'clear_history', message });
    }
  }
}
