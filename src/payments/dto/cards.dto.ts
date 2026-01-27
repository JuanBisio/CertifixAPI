import { IsString, IsOptional, IsBoolean, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SaveCardDto {
  @ApiProperty({ description: 'Card token from MercadoPago SDK' })
  @IsString()
  token: string;

  @ApiProperty({ description: 'Payment method ID (e.g., visa, master)' })
  @IsString()
  payment_method_id: string;

  @ApiProperty({ description: 'Payer email address' })
  @IsString()
  email: string;

  @ApiPropertyOptional({ description: 'Set as default payment method' })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}

export class PaymentMethodResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  card_last_four: string;

  @ApiProperty()
  card_brand: string;

  @ApiPropertyOptional()
  card_expiry_month?: number;

  @ApiPropertyOptional()
  card_expiry_year?: number;

  @ApiPropertyOptional()
  cardholder_name?: string;

  @ApiProperty()
  is_default: boolean;

  @ApiProperty()
  created_at: string;
}

export class PayWithSavedCardDto {
  @ApiProperty({ description: 'UUID of the solicitud to pay for' })
  @IsString()
  solicitud_id: string;

  @ApiProperty({ description: 'ID of the saved payment method' })
  @IsString()
  payment_method_id: string;

  @ApiPropertyOptional({ description: 'Number of installments' })
  @IsOptional()
  @IsNumber()
  installments?: number;
}
