import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { DisputasService } from './disputas.service';
import { CreateDisputaDto } from './dto/create-disputa.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Disputas (Disputes)')
@Controller('disputas')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class DisputasController {
  private readonly logger = new Logger(DisputasController.name);

  constructor(private disputasService: DisputasService) {}

  @Post()
  @ApiOperation({ summary: 'Create dispute for work request' })
  @ApiResponse({ status: 201, description: 'Dispute created successfully' })
  @ApiResponse({ status: 409, description: 'Dispute already exists' })
  async create(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() createDisputaDto: CreateDisputaDto,
  ) {
    this.logger.log(`Create dispute for trabajo: ${createDisputaDto.trabajo_id}`);
    return this.disputasService.create(user.id, createDisputaDto, accessToken);
  }

  @Get(':trabajoId')
  @ApiOperation({ summary: 'Get dispute info for work request' })
  @ApiResponse({ status: 200, description: 'Dispute retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async findByTrabajo(
    @Param('trabajoId') trabajoId: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get dispute for trabajo: ${trabajoId}`);
    return this.disputasService.findByTrabajo(trabajoId, user.id, accessToken);
  }
}