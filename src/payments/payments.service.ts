import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { CreatePaymentIntentDto, PaymentResponseDto, PaymentWebhookDto } from './dto/payments.dto';
import { MercadoPagoConfig, Payment, Preference } from 'mercadopago';

// Platform fee percentage (e.g., 10%)
const PLATFORM_FEE_PERCENT = 0.10;

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly mercadopago: MercadoPagoConfig;
  private readonly paymentClient: Payment;
  private readonly preferenceClient: Preference;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: ConfigService,
  ) {
    const accessToken = this.configService.get<string>('MERCADOPAGO_ACCESS_TOKEN');
    
    if (!accessToken) {
      this.logger.warn('MERCADOPAGO_ACCESS_TOKEN not configured');
    }
    
    this.mercadopago = new MercadoPagoConfig({ accessToken: accessToken || '' });
    this.paymentClient = new Payment(this.mercadopago);
    this.preferenceClient = new Preference(this.mercadopago);
  }

  /**
   * Creates a MercadoPago Preference for Checkout Pro (Wallet/Web).
   */
  async createPreference(
    solicitudId: string,
    email?: string,
    userId?: string,
  ): Promise<PaymentResponseDto> {
    const supabase = this.supabaseService.getClient();

    // 1. Fetch solicitud
    const { data: solicitud, error: fetchError } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, monto, estado, descripcion, rubros(nombre)')
      .eq('id', solicitudId)
      .single();

    if (fetchError || !solicitud) {
      throw new NotFoundException('Solicitud not found');
    }

    if (userId && solicitud.cliente_id !== userId) {
      throw new BadRequestException('You are not authorized to pay for this solicitud');
    }

    const amount = Number(solicitud.monto) || 0;
    const platformFee = amount * PLATFORM_FEE_PERCENT;
    const providerAmount = amount - platformFee;
    const paymentId = crypto.randomUUID();
    const rubroName = (solicitud as any).rubros?.nombre || 'Servicio CertiFix';

    try {
      // 2. Create Preference
      const preference = await this.preferenceClient.create({
        body: {
          items: [
            {
              id: solicitudId,
              title: `Servicio: ${rubroName}`,
              quantity: 1,
              unit_price: amount,
              currency_id: 'ARS', // Adjustable per region
            },
          ],
          payer: {
            email: email,
          },
          external_reference: paymentId,
          back_urls: {
            success: 'certifix://payment-success',
            failure: 'certifix://payment-failure',
            pending: 'certifix://payment-pending',
          },
          auto_return: 'approved',
          /* webhook URL handled globally via dashboard or notification_url here */
          notification_url: this.configService.get('WEBHOOK_URL') ? `${this.configService.get('WEBHOOK_URL')}/payments/webhook` : undefined,
          metadata: {
            payment_id: paymentId,
            solicitud_id: solicitudId,
            user_id: userId,
          },
        },
      });

      this.logger.log(`Preference created: ${preference.id}`);

      // 3. Save pending payment record
      // We need to save it so the webhook can find it by external_reference later
      await supabase.from('payments').insert({
        id: paymentId,
        solicitud_id: solicitudId,
        user_id: userId,
        amount: amount,
        platform_fee: platformFee,
        provider_amount: providerAmount,
        status: 'pending',
        provider_transaction_id: preference.id, // Storing preference ID temporarily
        payment_method: 'mercadopago_wallet',
      });

      return {
        id: paymentId,
        solicitud_id: solicitudId,
        amount: amount,
        status: 'pending',
        init_point: preference.init_point, // URL for frontend
        created_at: new Date().toISOString(),
      };
    } catch (error: any) {
      this.logger.error(`Error creating preference: ${error.message}`);
      throw new BadRequestException(`Failed to create payment preference: ${error.message}`);
    }
  }

  /**
   * Processes a payment using card token from MercadoPago SDK.
   * This is for transparent/in-app checkout.
   */
  async createPaymentIntent(
    dto: CreatePaymentIntentDto,
    userId: string,
  ): Promise<PaymentResponseDto> {
    const supabase = this.supabaseService.getClient();

    // 1. Fetch the solicitud to get amount and validate ownership
    const { data: solicitud, error: fetchError } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, monto, estado, descripcion, rubros(nombre)')
      .eq('id', dto.solicitud_id)
      .single();

    if (fetchError || !solicitud) {
      throw new NotFoundException('Solicitud not found');
    }

    if (solicitud.cliente_id !== userId) {
      throw new BadRequestException('You are not authorized to pay for this solicitud');
    }

    if (solicitud.estado !== 'aceptado') {
      throw new BadRequestException(`Cannot pay for solicitud in state: ${solicitud.estado}`);
    }

    const amount = Number(solicitud.monto) || 0;
    const platformFee = amount * PLATFORM_FEE_PERCENT;
    const providerAmount = amount - platformFee;

    const paymentId = crypto.randomUUID();
    const rubroName = (solicitud as any).rubros?.nombre || 'Servicio CertiFix';

    try {
      // 2. Process payment with MercadoPago Payment API
      const mpPayment = await this.paymentClient.create({
        body: {
          transaction_amount: amount,
          token: dto.token,
          description: `Servicio: ${rubroName}`,
          installments: dto.installments || 1,
          payment_method_id: dto.payment_method_id,
          issuer_id: dto.issuer_id ? Number(dto.issuer_id) : undefined,
          payer: {
            email: dto.payer_email,
          },
          external_reference: paymentId,
          metadata: {
            payment_id: paymentId,
            solicitud_id: dto.solicitud_id,
            user_id: userId,
          },
        },
      });

      this.logger.log(`MercadoPago payment created: ${mpPayment.id} - Status: ${mpPayment.status}`);

      // 3. Map MP status to our status
      let status: 'pending' | 'completed' | 'failed' = 'pending';
      if (mpPayment.status === 'approved') {
        status = 'completed';
      } else if (mpPayment.status === 'rejected' || mpPayment.status === 'cancelled') {
        status = 'failed';
      }

      // 4. Save payment record
      const { error: insertError } = await supabase.from('payments').insert({
        id: paymentId,
        solicitud_id: dto.solicitud_id,
        user_id: userId,
        amount: amount,
        platform_fee: platformFee,
        provider_amount: providerAmount,
        status: status,
        provider_transaction_id: String(mpPayment.id),
        payment_method: dto.payment_method_id,
      });

      if (insertError) {
        this.logger.error(`Failed to save payment: ${insertError.message}`);
      }

      // 5. If approved, update solicitud to 'pagado'
      if (status === 'completed') {
        await supabase
          .from('solicitudes_trabajo')
          .update({ estado: 'pagado', updated_at: new Date().toISOString() })
          .eq('id', dto.solicitud_id);
        
        this.logger.log(`Solicitud ${dto.solicitud_id} marked as pagado`);
      }

      // 6. Handle rejection
      if (status === 'failed') {
        const statusDetail = mpPayment.status_detail || 'unknown_error';
        throw new BadRequestException(`Payment rejected: ${this.getStatusDetailMessage(statusDetail)}`);
      }

      return {
        id: paymentId,
        solicitud_id: dto.solicitud_id,
        amount: amount,
        status: status,
        provider_transaction_id: String(mpPayment.id),
        created_at: new Date().toISOString(),
      };
    } catch (mpError: any) {
      this.logger.error(`MercadoPago error: ${mpError.message}`, mpError.stack);
      
      if (mpError instanceof BadRequestException) {
        throw mpError;
      }
      
      throw new BadRequestException(`Payment error: ${mpError.message}`);
    }
  }

  /**
   * Handles webhook events from MercadoPago.
   */
  async handleWebhook(dto: PaymentWebhookDto): Promise<{ success: boolean }> {
    const supabase = this.supabaseService.getClient();

    this.logger.log(`Webhook received: type=${dto.type} action=${dto.action}`);

    if ((dto.type === 'payment' || dto.action === 'payment.created') && dto.data?.id) {
      try {
        const mpPayment = await this.paymentClient.get({ id: Number(dto.data.id) });
        
        const externalReference = mpPayment.external_reference;
        if (!externalReference) {
          this.logger.warn('No external_reference in MercadoPago payment');
          return { success: true };
        }

        const { data: payment } = await supabase
          .from('payments')
          .select('id, solicitud_id, status')
          .eq('id', externalReference)
          .single();

        if (!payment) {
          return { success: true };
        }

        let newStatus: 'pending' | 'completed' | 'failed' | 'refunded' = 'pending';
        if (mpPayment.status === 'approved') {
          newStatus = 'completed';
        } else if (mpPayment.status === 'rejected' || mpPayment.status === 'cancelled') {
          newStatus = 'failed';
        } else if (mpPayment.status === 'refunded') {
          newStatus = 'refunded';
        }

        await supabase
          .from('payments')
          .update({ status: newStatus, updated_at: new Date().toISOString() })
          .eq('id', payment.id);

        if (newStatus === 'completed' && payment.status !== 'completed') {
          await supabase
            .from('solicitudes_trabajo')
            .update({ estado: 'pagado', updated_at: new Date().toISOString() })
            .eq('id', payment.solicitud_id);
        }

        return { success: true };
      } catch (error: any) {
        this.logger.error(`Error processing webhook: ${error.message}`);
        return { success: true }; // Return true to avoid MP retries
      }
    }

    return { success: true };
  }

  /**
   * Gets the status of a specific payment.
   */
  async getPaymentStatus(paymentId: string): Promise<PaymentResponseDto> {
    const supabase = this.supabaseService.getClient();

    const { data, error } = await supabase
      .from('payments')
      .select('id, solicitud_id, amount, status, provider_transaction_id, created_at')
      .eq('id', paymentId)
      .single();

    if (error || !data) {
      throw new NotFoundException('Payment not found');
    }

    return data as PaymentResponseDto;
  }

  /**
   * Maps MercadoPago status_detail to user-friendly message.
   */
  private getStatusDetailMessage(statusDetail: string): string {
    const messages: Record<string, string> = {
      accredited: 'Pago acreditado',
      pending_contingency: 'Pago pendiente de revisión',
      pending_review_manual: 'Pago en revisión manual',
      cc_rejected_bad_filled_card_number: 'Número de tarjeta incorrecto',
      cc_rejected_bad_filled_date: 'Fecha de vencimiento incorrecta',
      cc_rejected_bad_filled_other: 'Datos de tarjeta incorrectos',
      cc_rejected_bad_filled_security_code: 'Código de seguridad incorrecto',
      cc_rejected_blacklist: 'Tarjeta rechazada - contacta a tu banco',
      cc_rejected_call_for_authorize: 'Debes autorizar el pago con tu banco',
      cc_rejected_card_disabled: 'Tarjeta deshabilitada - contacta a tu banco',
      cc_rejected_duplicated_payment: 'Ya realizaste un pago por este monto',
      cc_rejected_high_risk: 'Pago rechazado por seguridad',
      cc_rejected_insufficient_amount: 'Fondos insuficientes',
      cc_rejected_invalid_installments: 'Cuotas no válidas para esta tarjeta',
      cc_rejected_max_attempts: 'Demasiados intentos - espera unos minutos',
      cc_rejected_other_reason: 'Pago rechazado - intenta con otra tarjeta',
    };

    return messages[statusDetail] || 'Pago rechazado - intenta nuevamente';
  }
}
