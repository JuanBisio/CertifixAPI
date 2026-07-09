import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { PrestadorInactividadService } from './prestador-inactividad.service';

@Module({
  controllers: [ProfilesController],
  providers: [ProfilesService, PrestadorInactividadService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
