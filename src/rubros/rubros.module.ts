import { Module } from '@nestjs/common';
import { RubrosController } from './rubros.controller';
import { RubrosService } from './rubros.service';

@Module({
  controllers: [RubrosController],
  providers: [RubrosService],
})
export class RubrosModule {}