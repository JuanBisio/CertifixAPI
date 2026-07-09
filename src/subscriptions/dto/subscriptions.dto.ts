import { IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PaySubscriptionDto {
  @ApiProperty({ description: 'ID of a saved payment method (see GET /cards)' })
  @IsString()
  payment_method_id: string;
}

export class SubscriptionStatusDto {
  @ApiProperty()
  activa: boolean;

  @ApiPropertyOptional({ description: 'ISO timestamp — null si nunca pagó' })
  vence_at: string | null;

  @ApiProperty({ description: 'Monto mensual de la suscripción en ARS' })
  monto_mensual: number;
}

export class SubscriptionPaymentDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  amount: number;

  @ApiProperty({ enum: ['pending', 'completed', 'failed'] })
  status: string;

  @ApiPropertyOptional()
  payment_method?: string;

  @ApiProperty()
  period_start: string;

  @ApiProperty()
  period_end: string;

  @ApiProperty()
  created_at: string;
}

export class PaySubscriptionResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiPropertyOptional()
  vence_at?: string;

  @ApiPropertyOptional()
  error?: string;
}
