import { Module } from '@nestjs/common';
import { RevocacionesController } from './revocaciones.controller';
import { RevocacionesService } from './revocaciones.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RevocacionesController],
  providers: [RevocacionesService],
  exports: [RevocacionesService],
})
export class RevocacionesModule {}
