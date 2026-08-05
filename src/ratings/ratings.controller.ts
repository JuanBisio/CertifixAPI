import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RatingsService } from './ratings.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AccessToken,
} from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Ratings')
@Controller('ratings')
export class RatingsController {
  constructor(private ratingsService: RatingsService) {}

  @Post()
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Calificar al prestador de una solicitud cerrada' })
  @ApiResponse({ status: 201, description: 'Calificación creada' })
  @ApiResponse({
    status: 400,
    description: 'Solicitud no cerrada o ya calificada',
  })
  @ApiResponse({ status: 403, description: 'No es tu solicitud' })
  async create(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: CreateRatingDto,
  ) {
    return this.ratingsService.createRating(user.id, dto, accessToken);
  }

  @Get('prestador/:id')
  @ApiOperation({ summary: 'Ver calificaciones públicas de un prestador' })
  async getRatingsPrestador(@Param('id') id: string) {
    return this.ratingsService.getRatingsPrestador(id);
  }

  @Get('cliente/:id')
  @ApiOperation({
    summary: 'Ver calificaciones públicas de un cliente (RQ-04)',
  })
  async getRatingsCliente(@Param('id') id: string) {
    return this.ratingsService.getRatingsCliente(id);
  }

  @Post('cliente')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'El prestador califica al cliente de una solicitud finalizada o cerrada',
  })
  @ApiResponse({ status: 201, description: 'Calificación creada' })
  @ApiResponse({
    status: 400,
    description: 'Solicitud no finalizada/cerrada o ya calificada',
  })
  @ApiResponse({ status: 403, description: 'No es tu solicitud' })
  async createRatingCliente(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: CreateRatingDto,
  ) {
    return this.ratingsService.createRatingCliente(user.id, dto, accessToken);
  }
}
