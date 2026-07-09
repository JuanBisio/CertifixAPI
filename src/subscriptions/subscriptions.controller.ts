import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import {
  PaySubscriptionDto,
  PaySubscriptionResponseDto,
  SubscriptionStatusDto,
  SubscriptionPaymentDto,
} from './dto/subscriptions.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Subscriptions')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Get('status')
  @ApiOperation({ summary: 'Estado actual de la suscripción del prestador' })
  @ApiResponse({ status: 200, type: SubscriptionStatusDto })
  async getStatus(@CurrentUser() user: User): Promise<SubscriptionStatusDto> {
    return this.subscriptionsService.getStatus(user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de pagos de suscripción del prestador' })
  @ApiResponse({ status: 200, type: [SubscriptionPaymentDto] })
  async getHistory(@CurrentUser() user: User): Promise<SubscriptionPaymentDto[]> {
    return this.subscriptionsService.getHistory(user.id);
  }

  @Post('pay')
  @ApiOperation({ summary: 'Pagar/renovar la suscripción mensual con una tarjeta guardada' })
  @ApiResponse({ status: 201, type: PaySubscriptionResponseDto })
  async pay(
    @Body() dto: PaySubscriptionDto,
    @CurrentUser() user: User,
  ): Promise<PaySubscriptionResponseDto> {
    return this.subscriptionsService.pay(dto, user.id);
  }
}
