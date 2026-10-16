import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [ProfilesModule, SubscriptionsModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
