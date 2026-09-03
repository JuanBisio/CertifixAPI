import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MercadoPagoConfig, PreApproval } from 'mercadopago';
import { SupabaseService } from '../supabase/supabase.service';
import {
  SubscribeDto,
  SubscribeResponseDto,
  SubscriptionStatusDto,
  SubscriptionPaymentDto,
  PreapprovalWebhookDto,
} from './dto/subscriptions.dto';

export const SUBSCRIPTION_AMOUNT = 30000;
export const TRABAJOS_GRATIS_LIMITE = 3;
export const SUBSCRIPTION_PERIOD_DAYS = 30;
const BACK_URL = 'https://certifix.app';
// Estados de un preapproval que no admiten reactivación — hay que crear uno nuevo.
const TERMINAL_STATUSES = ['cancelled'];

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly preApproval: PreApproval;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: ConfigService,
  ) {
    const accessToken = this.configService.get<string>(
      'MERCADOPAGO_ACCESS_TOKEN',
    );
    const mercadopago = new MercadoPagoConfig({
      accessToken: accessToken || '',
    });
    this.preApproval = new PreApproval(mercadopago);
  }

  async getStatus(prestadorId: string): Promise<SubscriptionStatusDto> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .select(
        'suscripcion_activa, suscripcion_cancelada, suscripcion_vence_at, suscripcion_card_last_four, suscripcion_card_brand, trabajos_gratis_usados',
      )
      .eq('id', prestadorId)
      .single();

    if (error || !data) {
      throw new BadRequestException('Perfil de prestador no encontrado');
    }

    const trabajosGratisRestantes = Math.max(
      TRABAJOS_GRATIS_LIMITE - (data.trabajos_gratis_usados ?? 0),
      0,
    );

    return {
      activa: data.suscripcion_activa,
      cancelada: data.suscripcion_cancelada,
      vence_at: data.suscripcion_vence_at,
      monto_mensual: SUBSCRIPTION_AMOUNT,
      card_last_four: data.suscripcion_card_last_four ?? undefined,
      card_brand: data.suscripcion_card_brand ?? undefined,
      trabajos_gratis_restantes: trabajosGratisRestantes,
      puede_recibir_solicitudes:
        data.suscripcion_activa || trabajosGratisRestantes > 0,
    };
  }

  async getHistory(prestadorId: string): Promise<SubscriptionPaymentDto[]> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('suscripcion_pagos')
      .select(
        'id, amount, status, payment_method, period_start, period_end, created_at',
      )
      .eq('prestador_id', prestadorId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException('No se pudo obtener el historial de pagos');
    }

    return data || [];
  }

  async subscribe(
    dto: SubscribeDto,
    prestadorId: string,
    email: string,
  ): Promise<SubscribeResponseDto> {
    const supabase = this.supabaseService.getServiceClient();

    const { data: prestador, error: fetchError } = await supabase
      .from('perfiles_prestadores')
      .select('mp_preapproval_id')
      .eq('id', prestadorId)
      .single();

    if (fetchError || !prestador) {
      throw new BadRequestException('Perfil de prestador no encontrado');
    }

    const periodStart = new Date();
    const periodEnd = new Date(
      periodStart.getTime() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    );

    try {
      let preapprovalId = prestador.mp_preapproval_id as string | null;
      let isNewPreapproval = !preapprovalId;

      if (preapprovalId) {
        const current = await this.preApproval.get({ id: preapprovalId });
        if (current.status && TERMINAL_STATUSES.includes(current.status)) {
          // No se puede reactivar un preapproval cancelado — hay que crear uno nuevo.
          preapprovalId = null;
          isNewPreapproval = true;
        }
      }

      if (preapprovalId) {
        await this.preApproval.update({
          id: preapprovalId,
          body: { card_token_id: dto.card_token, status: 'authorized' },
        });
      } else {
        const created = await this.preApproval.create({
          body: {
            reason: 'Suscripción mensual CertiFix',
            external_reference: prestadorId,
            payer_email: email,
            card_token_id: dto.card_token,
            back_url: BACK_URL,
            status: 'authorized',
            auto_recurring: {
              frequency: 1,
              frequency_type: 'months',
              transaction_amount: SUBSCRIPTION_AMOUNT,
              currency_id: 'ARS',
            },
          },
        });
        preapprovalId = created.id ?? null;
      }

      if (!preapprovalId) {
        throw new Error('MercadoPago no devolvió un id de preapproval');
      }

      // F3 (claude-security 2026-08-11): no marcar la suscripción activa ni
      // registrar un pago 'completed' antes de que MercadoPago confirme el
      // cobro real. Acá solo se persiste lo que ya es un hecho (el preapproval
      // quedó creado/actualizado con esta tarjeta) — suscripcion_activa,
      // suscripcion_vence_at y el historial de pagos los decide
      // syncPreapprovalStatus() re-consultando a MP, la misma función que usan
      // el webhook y el cron de sincronización (nunca confiar en el body).
      const { error: updateError } = await supabase
        .from('perfiles_prestadores')
        .update({
          mp_preapproval_id: preapprovalId,
          suscripcion_card_last_four: dto.card_last_four,
          suscripcion_card_brand: dto.card_brand,
          suscripcion_cancelada: false,
        })
        .eq('id', prestadorId);

      if (updateError) {
        this.logger.error(
          `Failed to activate suscripcion: ${updateError.message}`,
        );
        throw new BadRequestException(
          'La suscripción se creó en MercadoPago pero no se pudo activar localmente. Contactar soporte.',
        );
      }

      await this.syncPreapprovalStatus(preapprovalId);

      this.logger.log(
        `Suscripción (preapproval ${preapprovalId}) creada/actualizada para prestador ${prestadorId}, sincronizando estado real con MercadoPago`,
      );

      return { success: true, vence_at: periodEnd.toISOString() };
    } catch (err: any) {
      this.logger.error(
        `Error creando/actualizando preapproval: ${err.message}`,
      );
      return {
        success: false,
        error: err.message || 'No se pudo procesar la suscripción',
      };
    }
  }

  async cancel(prestadorId: string): Promise<{ success: boolean }> {
    const supabase = this.supabaseService.getServiceClient();

    const { data: prestador, error: fetchError } = await supabase
      .from('perfiles_prestadores')
      .select('mp_preapproval_id')
      .eq('id', prestadorId)
      .single();

    if (fetchError || !prestador?.mp_preapproval_id) {
      throw new BadRequestException(
        'No hay una suscripción activa para cancelar',
      );
    }

    await this.preApproval.update({
      id: prestador.mp_preapproval_id,
      body: { status: 'cancelled' },
    });

    // No se toca suscripcion_activa acá: el acceso sigue vigente hasta suscripcion_vence_at
    // (el período ya pagado). El cron desactivarVencidas() lo apaga cuando corresponda.
    await supabase
      .from('perfiles_prestadores')
      .update({ suscripcion_cancelada: true })
      .eq('id', prestadorId);

    this.logger.log(
      `Suscripción cancelada (preapproval ${prestador.mp_preapproval_id}) para prestador ${prestadorId}`,
    );

    return { success: true };
  }

  async handleWebhook(
    dto: PreapprovalWebhookDto,
  ): Promise<{ success: boolean }> {
    this.logger.log(`Webhook recibido: type=${dto.type} action=${dto.action}`);

    try {
      if (dto.type === 'subscription_preapproval' && dto.data?.id) {
        await this.syncPreapprovalStatus(dto.data.id);
      } else if (
        dto.type === 'subscription_authorized_payment' &&
        dto.data?.id
      ) {
        const preapprovalId =
          await this.resolvePreapprovalIdFromAuthorizedPayment(dto.data.id);
        if (preapprovalId) {
          await this.syncPreapprovalStatus(preapprovalId);
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Error procesando webhook de suscripción: ${err.message}`,
      );
    }

    return { success: true };
  }

  /**
   * Re-consulta un preapproval a MercadoPago (nunca confiar en el body del webhook) y
   * sincroniza estado + historial de pagos localmente. Reutilizado por el webhook y por
   * el cron de sincronización (safety net sin depender de un webhook público).
   */
  async syncPreapprovalStatus(preapprovalId: string): Promise<void> {
    const supabase = this.supabaseService.getServiceClient();
    const preapproval = await this.preApproval.get({ id: preapprovalId });

    const prestadorId = preapproval.external_reference;
    if (!prestadorId) {
      this.logger.warn(`Preapproval ${preapprovalId} sin external_reference`);
      return;
    }

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('suscripcion_charged_quantity')
      .eq('id', prestadorId)
      .single();

    const update: Record<string, unknown> = {};

    if (preapproval.status === 'authorized') {
      update.suscripcion_activa = true;
      update.suscripcion_cancelada = false;
      if (preapproval.next_payment_date) {
        update.suscripcion_vence_at = preapproval.next_payment_date;
      }
    } else if (preapproval.status === 'cancelled') {
      update.suscripcion_cancelada = true;
      // No tocar suscripcion_activa: sigue vigente hasta que pase suscripcion_vence_at.
    }

    // Detectar cobros nuevos (renovaciones) comparando contra el último conteo conocido.
    const chargedQuantity = preapproval.summarized?.charged_quantity ?? 0;
    const knownQuantity = prestador?.suscripcion_charged_quantity ?? 0;

    if (chargedQuantity > knownQuantity) {
      const periodStart = new Date();
      const periodEnd = new Date(
        periodStart.getTime() + SUBSCRIPTION_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );

      for (let i = knownQuantity; i < chargedQuantity; i++) {
        await supabase.from('suscripcion_pagos').insert({
          prestador_id: prestadorId,
          mp_preapproval_id: preapprovalId,
          amount:
            preapproval.auto_recurring?.transaction_amount ??
            SUBSCRIPTION_AMOUNT,
          status: 'completed',
          payment_method: preapproval.payment_method_id ?? null,
          period_start: periodStart.toISOString(),
          period_end: periodEnd.toISOString(),
        });
      }

      update.suscripcion_charged_quantity = chargedQuantity;
    }

    if (Object.keys(update).length === 0) {
      return;
    }

    const { error } = await supabase
      .from('perfiles_prestadores')
      .update(update)
      .eq('id', prestadorId);

    if (error) {
      this.logger.error(
        `Error sincronizando preapproval ${preapprovalId}: ${error.message}`,
      );
    }
  }

  private async resolvePreapprovalIdFromAuthorizedPayment(
    authorizedPaymentId: string,
  ): Promise<string | null> {
    const accessToken = this.configService.get<string>(
      'MERCADOPAGO_ACCESS_TOKEN',
    );

    // La API de Preapproval no tiene cliente propio en el SDK para "authorized payments";
    // se consulta por REST directo (mismo patrón que generateCardToken en cards.service.ts).
    const response = await fetch(
      `https://api.mercadopago.com/authorized_payments/${authorizedPaymentId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    const authorizedPayment = await response.json();

    if (!response.ok || !authorizedPayment.preapproval_id) {
      this.logger.warn(
        `No se pudo obtener el authorized_payment ${authorizedPaymentId}`,
      );
      return null;
    }

    return authorizedPayment.preapproval_id as string;
  }
}
