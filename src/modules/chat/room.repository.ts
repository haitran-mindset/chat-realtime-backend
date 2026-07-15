import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Room, RoomListItem } from './dto/chat.dto';

const GENERAL_ROOM_ID = 'general';
const GENERAL_ROOM_NAME = 'General';

/**
 * Persists chat rooms in PostgreSQL database using Prisma.
 * Ensures "general" room always exists and cannot be deleted.
 * All user-created rooms are private by default.
 */
@Injectable()
export class RoomRepository implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureGeneralRoom();
  }

  private async ensureGeneralRoom() {
    const exists = await this.prisma.room.findUnique({
      where: { id: GENERAL_ROOM_ID },
    });
    if (!exists) {
      await this.prisma.room.create({
        data: {
          id: GENERAL_ROOM_ID,
          name: GENERAL_ROOM_NAME,
          createdBy: 'system',
          createdAt: BigInt(Date.now()),
          isPrivate: false, // General is always public
        },
      });
    } else if (exists.isPrivate) {
      // Ensure General is always public (migration safety)
      await this.prisma.room.update({
        where: { id: GENERAL_ROOM_ID },
        data: { isPrivate: false },
      });
    }
  }

  /**
   * Get rooms visible to a specific user:
   * - The General room (always visible)
   * - All private rooms where user is a member
   */
  async getAllForUser(userId: string): Promise<RoomListItem[]> {
    const rooms = await this.prisma.room.findMany({
      where: {
        OR: [
          { id: GENERAL_ROOM_ID },
          {
            isPrivate: false,
          },
          {
            members: {
              some: { profileId: userId },
            },
          },
        ],
      },
    });

    // Sort: General first, then alphabetically
    rooms.sort((a, b) => {
      if (a.id === GENERAL_ROOM_ID) return -1;
      if (b.id === GENERAL_ROOM_ID) return 1;
      return a.name.localeCompare(b.name);
    });

    return rooms.map((r) => ({
      id: r.id,
      name: r.name,
      createdBy: r.createdBy,
      isPrivate: r.isPrivate,
    }));
  }

  /**
   * @deprecated Use getAllForUser(userId) instead.
   * Kept for internal use only.
   */
  async getAll(): Promise<RoomListItem[]> {
    const rooms = await this.prisma.room.findMany();
    rooms.sort((a, b) => {
      if (a.id === GENERAL_ROOM_ID) return -1;
      if (b.id === GENERAL_ROOM_ID) return 1;
      return a.name.localeCompare(b.name);
    });
    return rooms.map((r) => ({
      id: r.id,
      name: r.name,
      createdBy: r.createdBy,
      isPrivate: r.isPrivate,
    }));
  }

  private normalizeName(name: string): string {
    return name.trim();
  }

  /** Check if a room name is taken (case-insensitive). */
  async isNameTaken(name: string, excludeRoomId?: string): Promise<boolean> {
    const normalized = this.normalizeName(name);
    const room = await this.prisma.room.findFirst({
      where: {
        name: {
          equals: normalized,
          mode: 'insensitive',
        },
        NOT: excludeRoomId ? { id: excludeRoomId } : undefined,
      },
    });
    return room !== null;
  }

  async getById(id: string): Promise<Room | null> {
    const room = await this.prisma.room.findUnique({
      where: { id },
    });
    if (!room) return null;
    return {
      id: room.id,
      name: room.name,
      createdBy: room.createdBy,
      createdAt: Number(room.createdAt),
    };
  }

  /**
   * Check if a user is the owner (creator) of a room.
   */
  async isOwner(roomId: string, userId: string): Promise<boolean> {
    const room = await this.prisma.room.findUnique({
      where: { id: roomId },
      select: { createdBy: true },
    });
    return room?.createdBy === userId;
  }

  /**
   * Check if a user is a member of a room.
   */
  async isMember(roomId: string, userId: string): Promise<boolean> {
    if (roomId === GENERAL_ROOM_ID) return true;
    const member = await this.prisma.roomMember.findFirst({
      where: { roomId, profileId: userId },
    });
    return member !== null;
  }

  /**
   * Create a new private room. Creator is automatically added as a member.
   */
  async create(roomName: string, createdBy: string): Promise<Room> {
    const name = this.normalizeName(roomName);
    if (!name) throw new Error('Room name is required');
    if (await this.isNameTaken(name)) throw new Error('Room name already exists');

    const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const createdAt = Date.now();

    // Create room + add creator as member in a transaction
    await this.prisma.$transaction([
      this.prisma.room.create({
        data: {
          id,
          name,
          createdBy,
          createdAt: BigInt(createdAt),
          isPrivate: true,
        },
      }),
      this.prisma.roomMember.create({
        data: {
          profileId: createdBy,
          roomId: id,
          joinedAt: BigInt(createdAt),
        },
      }),
    ]);

    return { id, name, createdBy, createdAt };
  }

  async rename(roomId: string, newName: string): Promise<Room> {
    if (roomId === GENERAL_ROOM_ID) throw new Error('Cannot rename general room');
    const room = await this.getById(roomId);
    if (!room) throw new Error('Room not found');
    const name = this.normalizeName(newName);
    if (!name) throw new Error('Room name is required');
    if (await this.isNameTaken(name, roomId)) throw new Error('Room name already exists');

    await this.prisma.room.update({
      where: { id: roomId },
      data: { name },
    });
    return { ...room, name };
  }

  async delete(roomId: string): Promise<void> {
    if (roomId === GENERAL_ROOM_ID) throw new Error('Cannot delete general room');
    const room = await this.getById(roomId);
    if (!room) throw new Error('Room not found');
    await this.prisma.room.delete({
      where: { id: roomId },
    });
  }

  async joinRoom(profileId: string, roomId: string): Promise<void> {
    await this.prisma.roomMember.upsert({
      where: {
        uq_profile_room: {
          profileId,
          roomId,
        },
      },
      update: {},
      create: {
        profileId,
        roomId,
        joinedAt: BigInt(Date.now()),
      },
    });
  }

  async leaveRoom(profileId: string, roomId: string): Promise<void> {
    await this.prisma.roomMember.deleteMany({
      where: {
        profileId,
        roomId,
      },
    });
  }

  async getRoomsJoinedByUser(profileId: string): Promise<string[]> {
    const members = await this.prisma.roomMember.findMany({
      where: { profileId },
      select: { roomId: true },
    });
    return members.map((m) => m.roomId);
  }

  /**
   * Get all member profileIds for a room (excludes General).
   */
  async getRoomMemberIds(roomId: string): Promise<string[]> {
    const members = await this.prisma.roomMember.findMany({
      where: { roomId },
      select: { profileId: true },
    });
    return members.map((m) => m.profileId);
  }

  /**
   * Get all member details for a room.
   */
  async getRoomMembers(roomId: string) {
    const members = await this.prisma.roomMember.findMany({
      where: { roomId },
      include: {
        profile: {
          select: {
            id: true,
            username: true,
            avatar: true,
            bio: true,
          },
        },
      },
    });
    return members.map((m) => ({
      userId: m.profile.id,
      username: m.profile.username,
      avatar: m.profile.avatar,
      bio: m.profile.bio ?? '',
    }));
  }

  static getGeneralRoomId(): string {
    return GENERAL_ROOM_ID;
  }
}
