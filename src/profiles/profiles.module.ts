import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { PrestadorInactividadService } from './prestador-inactividad.service';
import { DocumentosVerificacionCleanupService } from './documentos-verificacion-cleanup.service';
import { AccountDeletionCleanupService } from './account-deletion-cleanup.service';

@Module({
  controllers: [ProfilesController],
  providers: [
    ProfilesService,
    PrestadorInactividadService,
    DocumentosVerificacionCleanupService,
    AccountDeletionCleanupService,
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
