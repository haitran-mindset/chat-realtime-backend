import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { MessageRepository } from './message.repository';
import { RoomRepository } from './room.repository';
import { ProfileRepository } from './profile.repository';
import { FriendshipRepository } from './friendship.repository';

/**
   * Chat module: WebSocket gateway, user/room management, message persistence.
   */
@Module({
  providers: [
    ChatGateway,
    ChatService,
    MessageRepository,
    RoomRepository,
    ProfileRepository,
    FriendshipRepository,
  ],
})
export class ChatModule {}

