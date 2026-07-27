import { Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import {
  SubscribeDto,
  SubscribeResponseDto,
  SubscriptionStatusDto,
  SubscriptionPaymentDto,
  PreapprovalWebhookDto,
} from './dto/subscriptions.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Estado actual de la suscripción del prestador' })
  @ApiResponse({ status: 200, type: SubscriptionStatusDto })
  async getStatus(@CurrentUser() user: User): Promise<SubscriptionStatusDto> {
    return this.subscriptionsService.getStatus(user.id);
  }

  @Get('history')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Historial de pagos de suscripción del prestador' })
  @ApiResponse({ status: 200, type: [SubscriptionPaymentDto] })
  async getHistory(@CurrentUser() user: User): Promise<SubscriptionPaymentDto[]> {
    return this.subscriptionsService.getHistory(user.id);
  }

  @Post('subscribe')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Suscribirse (o cambiar el método de pago de la suscripción activa)' })
  @ApiResponse({ status: 201, type: SubscribeResponseDto })
  async subscribe(
    @Body() dto: SubscribeDto,
    @CurrentUser() user: User,
  ): Promise<SubscribeResponseDto> {
    return this.subscriptionsService.subscribe(dto, user.id, user.email!);
  }

  @Post('cancel')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancelar la suscripción activa' })
  async cancel(@CurrentUser() user: User): Promise<{ success: boolean }> {
    return this.subscriptionsService.cancel(user.id);
  }

  @Post('webhook')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook de notificaciones de MercadoPago (Preapproval)' })
  async webhook(@Body() dto: PreapprovalWebhookDto): Promise<{ success: boolean }> {
    return this.subscriptionsService.handleWebhook(dto);
  }
}
