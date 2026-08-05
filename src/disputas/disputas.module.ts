import { Module } from '@nestjs/common';
import { DisputasController } from './disputas.controller';
import { DisputasService } from './disputas.service';

@Module({
  controllers: [DisputasController],
  providers: [DisputasService],
})
export class DisputasModule {}
