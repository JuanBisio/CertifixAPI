import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { EvidenciasModule } from '../evidencias/evidencias.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [ProfilesModule, EvidenciasModule, SubscriptionsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
