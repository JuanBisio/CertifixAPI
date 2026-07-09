import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { RubrosModule } from './rubros/rubros.module';
import { SolicitudesModule } from './solicitudes/solicitudes.module';
import { EvidenciasModule } from './evidencias/evidencias.module';
import { DisputasModule } from './disputas/disputas.module';
import { NotificationsModule } from './notifications/notifications.module';
// PaymentsModule (pago del trabajo cliente→prestador vía MercadoPago) — legacy, obsoleto.
// El precio del trabajo se acuerda en persona; ver SubscriptionsModule para el cobro real.
// import { PaymentsModule } from './payments/payments.module';
import { CardsModule } from './cards/cards.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { RatingsModule } from './ratings/ratings.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { AdminModule } from './admin/admin.module';
import { WelcomeController } from './welcome.controller';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    AuthModule,
    ProfilesModule,
    RubrosModule,
    SolicitudesModule,
    EvidenciasModule,
    DisputasModule,
    NotificationsModule,
    CardsModule,
    SubscriptionsModule,
    RatingsModule,
    AdminModule,
  ],
  controllers: [WelcomeController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
