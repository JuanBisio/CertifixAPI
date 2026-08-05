import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubscribeDto {
  @ApiProperty({
    description:
      'Card token generado por el SDK de MercadoPago (POST /v1/card_tokens)',
  })
  @IsString()
  card_token: string;

  @ApiProperty({
    description: 'Últimos 4 dígitos de la tarjeta, solo para mostrar en UI',
  })
  @IsString()
  card_last_four: string;

  @ApiProperty({
    description:
      'Marca de la tarjeta (visa, master, amex), solo para mostrar en UI',
  })
  @IsString()
  card_brand: string;
}

export class SubscriptionStatusDto {
  @ApiProperty()
  activa: boolean;

  @ApiProperty({
    description:
      'true si se canceló pero todavía tiene acceso hasta vence_at (período ya pagado)',
  })
  cancelada: boolean;

  @ApiPropertyOptional({ description: 'ISO timestamp — null si nunca pagó' })
  vence_at: string | null;

  @ApiProperty({ description: 'Monto mensual de la suscripción en ARS' })
  monto_mensual: number;

  @ApiPropertyOptional()
  card_last_four?: string;

  @ApiPropertyOptional()
  card_brand?: string;

  @ApiProperty({
    description:
      'Trabajos gratis de la promo de lanzamiento que le quedan (0 a 3)',
  })
  trabajos_gratis_restantes: number;

  @ApiProperty({
    description:
      'true si puede recibir solicitudes ahora (suscripción activa O créditos de promo disponibles)',
  })
  puede_recibir_solicitudes: boolean;
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

export class SubscribeResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiPropertyOptional()
  vence_at?: string;

  @ApiPropertyOptional()
  error?: string;
}

export class PreapprovalWebhookDto {
  @ApiPropertyOptional({
    description:
      'Tipo de notificación (ej. subscription_preapproval, subscription_authorized_payment)',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional({ description: 'Acción realizada' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({
    description: 'Payload con el id del recurso notificado',
  })
  @IsOptional()
  data?: { id?: string };
}
