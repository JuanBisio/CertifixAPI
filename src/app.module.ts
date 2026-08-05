import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { AddressesModule } from './addresses/addresses.module';
import { RubrosModule } from './rubros/rubros.module';
import { SolicitudesModule } from './solicitudes/solicitudes.module';
import { EvidenciasModule } from './evidencias/evidencias.module';
import { DisputasModule } from './disputas/disputas.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CardsModule } from './cards/cards.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { RatingsModule } from './ratings/ratings.module';
import { RevocacionesModule } from './revocaciones/revocaciones.module';
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
    ThrottlerModule.forRoot([
      {
        // default global: 60 requests/minuto por IP; endpoints sensibles bajan este límite con @Throttle()
        ttl: 60000,
        limit: 60,
      },
    ]),
    SupabaseModule,
    AuthModule,
    ProfilesModule,
    AddressesModule,
    RubrosModule,
    SolicitudesModule,
    EvidenciasModule,
    DisputasModule,
    NotificationsModule,
    CardsModule,
    SubscriptionsModule,
    RatingsModule,
    RevocacionesModule,
    AdminModule,
  ],
  controllers: [WelcomeController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
