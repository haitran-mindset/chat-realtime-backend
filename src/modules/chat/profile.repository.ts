import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Upsert user profile when they connect to the chat.
   */
  async upsertProfile(
    id: string,
    email: string,
    username: string,
    avatar: string = '',
    bio: string = '',
  ) {
    return this.prisma.profile.upsert({
      where: { id },
      update: {
        username,
        avatar,
        bio,
      },
      create: {
        id,
        email: email || `${username}@placeholder.com`, // Fallback if no email provided
        username,
        avatar,
        bio,
        createdAt: BigInt(Date.now()),
      },
    });
  }

  /**
   * Update profile fields specifically (without overwriting email).
   */
  async updateProfile(id: string, username: string, avatar: string, bio: string = '') {
    return this.prisma.profile.update({
      where: { id },
      data: {
        username,
        avatar,
        bio,
      },
    });
  }

  /**
   * Get the role of a user. Returns 'USER' if not found.
   */
  async getRole(id: string): Promise<'USER' | 'ADMIN'> {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      select: { role: true },
    });
    if (!profile) return 'USER';
    return profile.role === 'ADMIN' ? 'ADMIN' : 'USER';
  }

  /**
   * Retrieve a user profile by their Supabase ID.
   */
  async getProfile(id: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id },
      include: {
        rooms: {
          select: {
            roomId: true,
          },
        },
      },
    });

    if (!profile) return null;

    return {
      id: profile.id,
      email: profile.email,
      username: profile.username,
      avatar: profile.avatar,
      bio: profile.bio,
      role: profile.role as 'USER' | 'ADMIN',
      joinedRoomIds: profile.rooms.map((r) => r.roomId),
    };
  }
}
