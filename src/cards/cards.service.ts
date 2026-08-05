import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { SaveCardDto, PaymentMethodResponseDto } from './dto/cards.dto';
import { MercadoPagoConfig, Customer, CardToken, Payment } from 'mercadopago';

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);
  private readonly mercadopago: MercadoPagoConfig;
  private readonly customerClient: Customer;
  private readonly paymentClient: Payment;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly configService: ConfigService,
  ) {
    const accessToken = this.configService.get<string>(
      'MERCADOPAGO_ACCESS_TOKEN',
    );
    this.mercadopago = new MercadoPagoConfig({
      accessToken: accessToken || '',
    });
    this.customerClient = new Customer(this.mercadopago);
    this.paymentClient = new Payment(this.mercadopago);
  }

  /**
   * Gets or creates a MercadoPago customer for the user.
   */
  private async getOrCreateCustomer(
    userId: string,
    email: string,
  ): Promise<string> {
    const supabase = this.supabaseService.getServiceClient();

    // Check if user already has a customer ID stored
    const { data: existingMethod } = await supabase
      .from('users_payment_methods')
      .select('mp_customer_id')
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (existingMethod?.mp_customer_id) {
      return existingMethod.mp_customer_id;
    }

    // Search for existing customer by email
    const searchResult = await this.customerClient.search({
      options: { email },
    });

    if (searchResult.results && searchResult.results.length > 0) {
      return searchResult.results[0].id as string;
    }

    // Create new customer
    const newCustomer = await this.customerClient.create({
      body: { email },
    });

    this.logger.log(`Created MercadoPago customer: ${newCustomer.id}`);
    return newCustomer.id as string;
  }

  /**
   * Saves a card for future payments.
   */
  async saveCard(
    dto: SaveCardDto,
    userId: string,
  ): Promise<PaymentMethodResponseDto> {
    const supabase = this.supabaseService.getServiceClient();

    try {
      // Get or create customer
      const customerId = await this.getOrCreateCustomer(userId, dto.email);

      // Associate card with customer
      const card = await this.customerClient.createCard({
        customerId,
        body: { token: dto.token },
      });

      this.logger.log(`Saved card ${card.id} for customer ${customerId}`);

      // If setting as default, unset other defaults first
      if (dto.is_default) {
        await supabase
          .from('users_payment_methods')
          .update({ is_default: false })
          .eq('user_id', userId);
      }

      // Save to database
      const { data, error } = await supabase
        .from('users_payment_methods')
        .insert({
          user_id: userId,
          mp_customer_id: customerId,
          mp_card_id: card.id,
          card_last_four: card.last_four_digits,
          card_brand: dto.payment_method_id,
          card_expiry_month: card.expiration_month,
          card_expiry_year: card.expiration_year,
          cardholder_name: card.cardholder?.name,
          is_default: dto.is_default ?? false,
        })
        .select()
        .single();

      if (error) {
        throw new BadRequestException(`Failed to save card: ${error.message}`);
      }

      return this.mapToResponse(data);
    } catch (err: any) {
      this.logger.error(`Error saving card: ${err.message}`);
      throw new BadRequestException(err.message || 'Failed to save card');
    }
  }

  /**
   * Gets all saved cards for a user.
   */
  async getSavedCards(userId: string): Promise<PaymentMethodResponseDto[]> {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('users_payment_methods')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException('Failed to fetch cards');
    }

    return (data || []).map(this.mapToResponse);
  }

  /**
   * Deletes a saved card.
   */
  async deleteCard(
    cardId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const supabase = this.supabaseService.getServiceClient();

    const { data: card, error: fetchError } = await supabase
      .from('users_payment_methods')
      .select('mp_customer_id, mp_card_id')
      .eq('id', cardId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !card) {
      throw new NotFoundException('Card not found');
    }

    // Delete from MercadoPago using REST API (SDK doesn't have deleteCard)
    try {
      const accessToken = this.configService.get<string>(
        'MERCADOPAGO_ACCESS_TOKEN',
      );
      await fetch(
        `https://api.mercadopago.com/v1/customers/${card.mp_customer_id}/cards/${card.mp_card_id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );
    } catch (err: any) {
      this.logger.warn(`Failed to delete card from MP: ${err.message}`);
    }

    // Soft delete in database
    const { error } = await supabase
      .from('users_payment_methods')
      .update({ is_active: false })
      .eq('id', cardId)
      .eq('user_id', userId);

    if (error) {
      throw new BadRequestException('Failed to delete card');
    }

    return { success: true };
  }

  /**
   * Sets a card as default.
   */
  async setDefaultCard(
    cardId: string,
    userId: string,
  ): Promise<{ success: boolean }> {
    const supabase = this.supabaseService.getServiceClient();

    // Unset all defaults
    await supabase
      .from('users_payment_methods')
      .update({ is_default: false })
      .eq('user_id', userId);

    // Set new default
    const { error } = await supabase
      .from('users_payment_methods')
      .update({ is_default: true })
      .eq('id', cardId)
      .eq('user_id', userId);

    if (error) {
      throw new BadRequestException('Failed to set default card');
    }

    return { success: true };
  }

  /**
   * Generates a payment token from a saved card.
   */
  private async generateCardToken(cardId: string): Promise<string> {
    try {
      const mpAccessToken = this.configService.get<string>(
        'MERCADOPAGO_ACCESS_TOKEN',
      );
      // We use fetch since the Node SDK might not expose this specific endpoint easily for saved cards
      const response = await fetch(
        `https://api.mercadopago.com/v1/card_tokens?public_key=${this.configService.get('MERCADOPAGO_PUBLIC_KEY')}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mpAccessToken}`,
          },
          body: JSON.stringify({ card_id: cardId }),
        },
      );

      const data = await response.json();

      if (!response.ok || !data.id) {
        throw new Error(
          data.message || 'Could not generate token for saved card',
        );
      }

      return data.id;
    } catch (error) {
      this.logger.error(
        `Error generating token for saved card: ${error.message}`,
      );
      throw new BadRequestException('Failed to process saved card');
    }
  }

  /**
   * Charges a saved card for a fixed amount, not tied to a solicitud.
   * Used by SubscriptionsService to bill the prestador's monthly subscription.
   */
  async chargeSavedCard(
    paymentMethodId: string,
    userId: string,
    amount: number,
    description: string,
  ): Promise<{
    success: boolean;
    provider_transaction_id?: string;
    status: 'completed' | 'failed';
    error?: string;
  }> {
    const supabase = this.supabaseService.getServiceClient();

    const { data: savedCard, error: cardError } = await supabase
      .from('users_payment_methods')
      .select('*')
      .eq('id', paymentMethodId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .single();

    if (cardError || !savedCard) {
      throw new NotFoundException('Payment method not found');
    }

    const token = await this.generateCardToken(savedCard.mp_card_id);

    try {
      const mpPayment = await this.paymentClient.create({
        body: {
          transaction_amount: amount,
          token,
          description,
          installments: 1,
          payment_method_id: savedCard.card_brand,
          payer: {
            type: 'customer',
            id: savedCard.mp_customer_id,
          },
        },
      });

      const status = mpPayment.status === 'approved' ? 'completed' : 'failed';

      return {
        success: status === 'completed',
        provider_transaction_id: String(mpPayment.id),
        status,
        error: status === 'failed' ? 'Pago rechazado' : undefined,
      };
    } catch (err: any) {
      this.logger.error(`chargeSavedCard failed: ${err.message}`);
      return { success: false, status: 'failed', error: err.message };
    }
  }

  private mapToResponse(row: any): PaymentMethodResponseDto {
    return {
      id: row.id,
      card_last_four: row.card_last_four,
      card_brand: row.card_brand,
      card_expiry_month: row.card_expiry_month,
      card_expiry_year: row.card_expiry_year,
      cardholder_name: row.cardholder_name,
      is_default: row.is_default,
      created_at: row.created_at,
    };
  }
}
