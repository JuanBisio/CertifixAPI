import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsCronService } from './subscriptions-cron.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { CardsModule } from '../cards/cards.module';

@Module({
  imports: [SupabaseModule, CardsModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsCronService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
