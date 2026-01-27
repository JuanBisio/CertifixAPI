import { IsUUID, IsOptional, IsString, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePaymentIntentDto {
  @ApiProperty({ description: 'UUID of the solicitud to pay for' })
  @IsUUID()
  solicitud_id: string;

  @ApiProperty({ description: 'Card token from MercadoPago SDK' })
  @IsString()
  token: string;

  @ApiProperty({ description: 'Payment method ID (e.g., visa, master)' })
  @IsString()
  payment_method_id: string;

  @ApiProperty({ description: 'Number of installments' })
  @IsNumber()
  installments: number;

  @ApiProperty({ description: 'Payer email address' })
  @IsString()
  payer_email: string;

  @ApiPropertyOptional({ description: 'Issuer ID for the card' })
  @IsOptional()
  @IsString()
  issuer_id?: string;
}

export class CreatePreferenceDto {
  @ApiProperty({ description: 'UUID of the solicitud to pay for' })
  @IsUUID()
  solicitud_id: string;

  @ApiPropertyOptional({ description: 'Payer email address' })
  @IsOptional()
  @IsString()
  payer_email?: string;
}

export class PaymentWebhookDto {
  @ApiProperty({ description: 'Event type from payment provider' })
  @IsString()
  @IsOptional()
  event_type?: string;

  @ApiPropertyOptional({ description: 'Transaction ID from payment provider' })
  @IsOptional()
  @IsString()
  transaction_id?: string;

  @ApiPropertyOptional({ description: 'Type of notification (for MercadoPago)' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Action performed' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Status of the payment' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Data payload from provider (contains id for MP)' })
  @IsOptional()
  data?: { id?: number | string };
}

export class PaymentResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  solicitud_id: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  status: 'pending' | 'completed' | 'failed' | 'refunded';

  @ApiPropertyOptional()
  provider_transaction_id?: string;

  @ApiPropertyOptional({ description: 'MercadoPago checkout URL' })
  init_point?: string;

  @ApiPropertyOptional()
  created_at?: string;
}
