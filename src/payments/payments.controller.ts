import { Controller, Post, Get, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentIntentDto, PaymentWebhookDto, PaymentResponseDto, CreatePreferenceDto } from './dto/payments.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('create-intent')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a payment intent for a solicitud' })
  @ApiResponse({ status: 201, description: 'Payment intent created', type: PaymentResponseDto })
  async createPaymentIntent(
    @Body() dto: CreatePaymentIntentDto,
    @CurrentUser() user: User,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.createPaymentIntent(dto, user.id);
  }

  @Post('create-preference')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a payment preference (Wallet/Web)' })
  @ApiResponse({ status: 201, description: 'Preference created', type: PaymentResponseDto })
  async createPreference(
    @Body() dto: CreatePreferenceDto,
    @CurrentUser() user: User,
  ): Promise<PaymentResponseDto> {
    return this.paymentsService.createPreference(dto.solicitud_id, dto.payer_email, user.id);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Handle payment provider webhook events' })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  async handleWebhook(@Body() dto: PaymentWebhookDto): Promise<{ success: boolean }> {
    // Note: In production, verify webhook signature before processing
    return this.paymentsService.handleWebhook(dto);
  }

  @Get('status/:id')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the status of a payment' })
  @ApiResponse({ status: 200, description: 'Payment status', type: PaymentResponseDto })
  async getPaymentStatus(@Param('id') id: string): Promise<PaymentResponseDto> {
    return this.paymentsService.getPaymentStatus(id);
  }
}
