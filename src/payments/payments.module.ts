import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [PaymentsController, CardsController],
  providers: [PaymentsService, CardsService],
  exports: [PaymentsService, CardsService],
})
export class PaymentsModule {}
