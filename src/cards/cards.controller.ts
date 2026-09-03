import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { CardsService } from './cards.service';
import { SaveCardDto, PaymentMethodResponseDto } from './dto/cards.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import type { Request } from 'express';

@ApiTags('Cards')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard)
@Controller('cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Post()
  @ApiOperation({ summary: 'Save a card for future payments' })
  @ApiResponse({ status: 201, type: PaymentMethodResponseDto })
  async saveCard(@Body() dto: SaveCardDto, @Req() req: Request) {
    const userId = (req as any).user?.id;
    const userEmail = (req as any).user?.email;
    return this.cardsService.saveCard(dto, userId, userEmail);
  }

  @Get()
  @ApiOperation({ summary: 'Get all saved cards for current user' })
  @ApiResponse({ status: 200, type: [PaymentMethodResponseDto] })
  async getSavedCards(@Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.cardsService.getSavedCards(userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a saved card' })
  async deleteCard(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.cardsService.deleteCard(id, userId);
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Set a card as default' })
  async setDefault(@Param('id') id: string, @Req() req: Request) {
    const userId = (req as any).user?.id;
    return this.cardsService.setDefaultCard(id, userId);
  }
}
