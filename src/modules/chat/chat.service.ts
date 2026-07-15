import { Injectable } from '@nestjs/common';
import { ConnectedUser } from './dto/chat.dto';

/**
 * ChatService: manages connected users and rooms in memory.
 * Production systems would use Redis or a database for multi-instance scaling.
 */
@Injectable()
export class ChatService {
  /** Map: socketId -> user info and joined rooms */
  private readonly connectedUsers = new Map<string, ConnectedUser>();

  /** Map: roomId -> Set of socketIds in that room */
  private readonly rooms = new Map<string, Set<string>>();

  /**
   * Register a user on connection.
   */
  addUser(socketId: string, userId: string, username: string, avatar: string = ''): void {
    this.connectedUsers.set(socketId, {
      socketId,
      userId,
      username,
      avatar: avatar || '',
      joinedRooms: new Set(),
    });
  }

  /**
   * Remove user and clean up room memberships.
   */
  removeUser(socketId: string): ConnectedUser | undefined {
    const user = this.connectedUsers.get(socketId);
    if (!user) return undefined;

    user.joinedRooms.forEach((roomId) => this.leaveRoomInternal(socketId, roomId));
    this.connectedUsers.delete(socketId);
    return user;
  }

  /**
   * Get all connected users as array (for online users list).
   */
  getOnlineUsers(): Array<{ userId: string; username: string; avatar: string; socketId: string }> {
    const uniqueUsers = new Map<string, { userId: string; username: string; avatar: string; socketId: string }>();
    for (const [sid, u] of this.connectedUsers) {
      if (!uniqueUsers.has(u.userId)) {
        uniqueUsers.set(u.userId, {
          userId: u.userId,
          username: u.username,
          avatar: u.avatar || '',
          socketId: sid,
        });
      }
    }
    return Array.from(uniqueUsers.values());
  }


  /**
   * Get user by socket ID.
   */
  getUserBySocketId(socketId: string): ConnectedUser | undefined {
    return this.connectedUsers.get(socketId);
  }

  /**
   * Get socket ID for a userId (first match; users may have multiple tabs).
   */
  getSocketIdByUserId(userId: string): string | undefined {
    for (const [sid, u] of this.connectedUsers) {
      if (u.userId === userId) return sid;
    }
    return undefined;
  }

  /**
   * Get all active socket IDs for a userId (in case of multiple tabs or laggy disconnect).
   */
  getSocketIdsByUserId(userId: string): string[] {
    const sids: string[] = [];
    for (const [sid, u] of this.connectedUsers) {
      if (u.userId === userId) {
        sids.push(sid);
      }
    }
    return sids;
  }

  /**
   * Add user to a room.
   */
  joinRoom(socketId: string, roomId: string): void {
    const user = this.connectedUsers.get(socketId);
    if (!user) return;

    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
    }
    this.rooms.get(roomId)!.add(socketId);
    user.joinedRooms.add(roomId);
  }

  /**
   * Remove user from a room (internal cleanup).
   */
  private leaveRoomInternal(socketId: string, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(socketId);
      if (room.size === 0) this.rooms.delete(roomId);
    }
    this.connectedUsers.get(socketId)?.joinedRooms.delete(roomId);
  }

  /**
   * User explicitly leaves a room.
   * Returns true if they were in the room, false otherwise.
   */
  leaveRoom(socketId: string, roomId: string): boolean {
    const user = this.connectedUsers.get(socketId);
    if (!user) return false;
    const wasMember = user.joinedRooms.has(roomId);
    if (wasMember) {
      this.leaveRoomInternal(socketId, roomId);
    }
    return wasMember;
  }

  /**
   * Get socket IDs in a room.
   */
  getRoomMemberSocketIds(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room) : [];
  }
}
