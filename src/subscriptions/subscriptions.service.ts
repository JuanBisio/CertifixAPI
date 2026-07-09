import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CardsService } from '../cards/cards.service';
import {
  PaySubscriptionDto,
  PaySubscriptionResponseDto,
  SubscriptionStatusDto,
  SubscriptionPaymentDto,
} from './dto/subscriptions.dto';

export const SUBSCRIPTION_AMOUNT = 30000;
const SUBSCRIPTION_PERIOD_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly cardsService: CardsService,
  ) {}

  async getStatus(prestadorId: string): Promise<SubscriptionStatusDto> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .select('suscripcion_activa, suscripcion_vence_at')
      .eq('id', prestadorId)
      .single();

    if (error || !data) {
      throw new BadRequestException('Perfil de prestador no encontrado');
    }

    return {
      activa: data.suscripcion_activa,
      vence_at: data.suscripcion_vence_at,
      monto_mensual: SUBSCRIPTION_AMOUNT,
    };
  }

  async getHistory(prestadorId: string): Promise<SubscriptionPaymentDto[]> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('suscripcion_pagos')
      .select('id, amount, status, payment_method, period_start, period_end, created_at')
      .eq('prestador_id', prestadorId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException('No se pudo obtener el historial de pagos');
    }

    return data || [];
  }

  async pay(dto: PaySubscriptionDto, prestadorId: string): Promise<PaySubscriptionResponseDto> {
    const supabase = this.supabaseService.getServiceClient();

    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    const charge = await this.cardsService.chargeSavedCard(
      dto.payment_method_id,
      prestadorId,
      SUBSCRIPTION_AMOUNT,
      'Suscripción mensual CertiFix',
    );

    const { error: insertError } = await supabase.from('suscripcion_pagos').insert({
      prestador_id: prestadorId,
      amount: SUBSCRIPTION_AMOUNT,
      status: charge.status,
      payment_method: dto.payment_method_id,
      provider_transaction_id: charge.provider_transaction_id,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    });

    if (insertError) {
      this.logger.error(`Failed to save suscripcion_pago: ${insertError.message}`);
    }

    if (!charge.success) {
      return { success: false, error: charge.error || 'Pago rechazado' };
    }

    const { error: updateError } = await supabase
      .from('perfiles_prestadores')
      .update({
        suscripcion_activa: true,
        suscripcion_vence_at: periodEnd.toISOString(),
      })
      .eq('id', prestadorId);

    if (updateError) {
      this.logger.error(`Failed to activate suscripcion: ${updateError.message}`);
      throw new BadRequestException('El pago se procesó pero no se pudo activar la suscripción. Contactar soporte.');
    }

    this.logger.log(`Suscripción activada para prestador ${prestadorId} hasta ${periodEnd.toISOString()}`);

    return { success: true, vence_at: periodEnd.toISOString() };
  }
}
