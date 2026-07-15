import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { ChatModule } from './modules/chat/chat.module';

/**
 * Root application module.
 * Registers all feature modules.
 */
@Module({
  imports: [PrismaModule, ChatModule],
})
export class AppModule {}
