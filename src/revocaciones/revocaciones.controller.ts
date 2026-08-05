import { Controller, Get, Post, Body, UseGuards, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RevocacionesService } from './revocaciones.service';
import { CreateRevocacionDto } from './dto/create-revocacion.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AccessToken,
} from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Revocaciones (derecho de arrepentimiento)')
@Controller('revocaciones')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class RevocacionesController {
  private readonly logger = new Logger(RevocacionesController.name);

  constructor(private revocacionesService: RevocacionesService) {}

  @Get('elegibilidad')
  @ApiOperation({
    summary:
      'Check right-of-withdrawal eligibility and prefill data for the current user',
  })
  @ApiResponse({
    status: 200,
    description: 'Eligibility computed successfully',
  })
  async getElegibilidad(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.revocacionesService.getElegibilidad(user, accessToken);
  }

  @Post()
  @ApiOperation({ summary: 'Submit a right-of-withdrawal request' })
  @ApiResponse({ status: 201, description: 'Request created successfully' })
  @ApiResponse({ status: 403, description: 'Withdrawal window expired' })
  @ApiResponse({
    status: 409,
    description: 'A request already exists for this account',
  })
  async crear(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: CreateRevocacionDto,
  ) {
    this.logger.log(`Create solicitud de revocación for perfil: ${user.id}`);
    return this.revocacionesService.crear(user, accessToken, dto);
  }
}
