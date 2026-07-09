import { Module } from '@nestjs/common';
import { SolicitudesController } from './solicitudes.controller';
import { SolicitudesService } from './solicitudes.service';
import { SolicitudesTimeoutService } from './solicitudes-timeout.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [SolicitudesController],
  providers: [SolicitudesService, SolicitudesTimeoutService],
})
export class SolicitudesModule {}
