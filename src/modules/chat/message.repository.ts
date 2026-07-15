import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StoredMessage } from './dto/chat.dto';

/**
 * Persists chat messages in PostgreSQL database using Prisma.
 * Stores room messages (including general) for history.
 */
@Injectable()
export class MessageRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Save a message (room message or private message).
   */
  async save(message: StoredMessage): Promise<void> {
    await this.prisma.message.create({
      data: {
        id: message.id,
        userId: message.userId,
        username: message.username,
        avatar: message.avatar ?? '',
        message: message.message,
        roomId: message.roomId ?? null,
        targetUserId: message.targetUserId ?? null,
        timestamp: BigInt(message.timestamp),
      },
    });
  }

  /**
   * Get last 50 messages for a room, oldest first (for display order).
   */
  async getLast50ByRoom(roomId: string): Promise<StoredMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { roomId: roomId ?? null },
      orderBy: { timestamp: 'asc' },
      take: 50,
    });
    return messages.map((m) => ({
      id: m.id,
      userId: m.userId,
      username: m.username,
      avatar: m.avatar,
      message: m.message,
      roomId: m.roomId,
      targetUserId: m.targetUserId,
      timestamp: Number(m.timestamp),
    }));
  }

  /**
   * Get last 50 private messages between two users, oldest first.
   */
  async getPrivateHistory(userId1: string, userId2: string): Promise<StoredMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: {
        OR: [
          { userId: userId1, targetUserId: userId2 },
          { userId: userId2, targetUserId: userId1 },
        ],
      },
      orderBy: { timestamp: 'asc' },
      take: 50,
    });
    return messages.map((m) => ({
      id: m.id,
      userId: m.userId,
      username: m.username,
      avatar: m.avatar,
      message: m.message,
      roomId: m.roomId,
      targetUserId: m.targetUserId,
      timestamp: Number(m.timestamp),
    }));
  }

  /**
   * Delete all messages in a specific room (ADMIN only).
   */
  async deleteAllByRoom(roomId: string): Promise<number> {
    const result = await this.prisma.message.deleteMany({
      where: { roomId },
    });
    return result.count;
  }

}
