import { Module } from '@nestjs/common';
import { EvidenciasController } from './evidencias.controller';
import { EvidenciasService } from './evidencias.service';
import { EvidenciasCleanupService } from './evidencias-cleanup.service';

@Module({
  controllers: [EvidenciasController],
  providers: [EvidenciasService, EvidenciasCleanupService],
})
export class EvidenciasModule {}
