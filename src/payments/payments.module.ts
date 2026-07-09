import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SupabaseModule } from '../supabase/supabase.module';

// NOTA: Módulo legacy — pago del trabajo cliente→prestador vía MercadoPago.
// Obsoleto con el modelo de suscripción (el precio del trabajo se acuerda en persona).
// No se registra en AppModule. Ver docs/ROADMAP.md.
@Module({
  imports: [SupabaseModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
