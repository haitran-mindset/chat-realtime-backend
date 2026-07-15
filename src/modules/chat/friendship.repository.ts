import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FriendshipRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Send a friend request from userId to friendId.
   * If a request from friendId to userId already exists, it is accepted automatically.
   */
  async sendRequest(userId: string, friendId: string) {
    if (userId === friendId) {
      throw new Error('You cannot add yourself as a friend');
    }

    // Check if friendship or request already exists
    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        throw new Error('You are already friends');
      }
      if (existing.userId === userId) {
        throw new Error('Friend request already sent');
      } else {
        // The other user already sent a request, so accept it!
        return this.respondToRequest(friendId, userId, true);
      }
    }

    return this.prisma.friendship.create({
      data: {
        userId,
        friendId,
        status: 'PENDING',
        createdAt: BigInt(Date.now()),
      },
    });
  }

  /**
   * Accept or decline a pending friend request.
   */
  async respondToRequest(requesterId: string, recipientId: string, accept: boolean) {
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        userId: requesterId,
        friendId: recipientId,
      },
    });


    if (!friendship) {
      throw new Error('Friend request not found');
    }

    if (accept) {
      return this.prisma.friendship.update({
        where: {
          id: friendship.id,
        },
        data: {
          status: 'ACCEPTED',
        },
      });
    } else {
      return this.prisma.friendship.delete({
        where: {
          id: friendship.id,
        },
      });
    }
  }

  /**
   * Remove a friend.
   */
  async removeFriend(userId: string, friendId: string) {
    const friendship = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });

    if (!friendship) {
      throw new Error('Friendship not found');
    }

    return this.prisma.friendship.delete({
      where: {
        id: friendship.id,
      },
    });
  }

  /**
   * Get friends, pending requests sent, and pending requests received for a user.
   */
  async getFriendships(userId: string) {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { userId },
          { friendId: userId },
        ],
      },
      include: {
        user: true,
        friend: true,
      },
    });

    const friends: any[] = [];
    const pendingSent: any[] = [];
    const pendingReceived: any[] = [];

    for (const f of friendships) {
      const isRequester = f.userId === userId;
      const otherProfile = isRequester ? f.friend : f.user;

      const profileData = {
        userId: otherProfile.id,
        username: otherProfile.username,
        avatar: otherProfile.avatar,
        bio: otherProfile.bio ?? '',
      };

      if (f.status === 'ACCEPTED') {
        friends.push(profileData);
      } else {
        if (isRequester) {
          pendingSent.push(profileData);
        } else {
          pendingReceived.push(profileData);
        }
      }
    }

    return {
      friends,
      pendingSent,
      pendingReceived,
    };
  }
}
