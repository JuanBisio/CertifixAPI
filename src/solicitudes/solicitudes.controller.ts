import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SolicitudesService } from './solicitudes.service';
import { CreateSolicitudDto } from './dto/create-solicitud.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Solicitudes')
@Controller('solicitudes')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SolicitudesController {
  private readonly logger = new Logger(SolicitudesController.name);

  constructor(private solicitudesService: SolicitudesService) {}

  @Post()
  @ApiOperation({ summary: 'Crear solicitud de trabajo (solo clientes)' })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 403, description: 'Solo clientes pueden crear solicitudes' })
  async create(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: CreateSolicitudDto,
  ) {
    this.logger.log(`Crear solicitud - user: ${user.id}`);
    return this.solicitudesService.create(user.id, dto, accessToken);
  }

  @Get()
  @ApiOperation({
    summary: 'Listar solicitudes según rol',
    description: 'Clientes ven sus propias solicitudes. Prestadores verificados ven trabajos disponibles por rubro y radio.',
  })
  async findAll(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.findAll(user.id, accessToken);
  }

  @Get('my-active')
  @ApiOperation({ summary: 'Trabajo activo del prestador (aceptado/finalizado)' })
  async getMyActive(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.getMyActive(user.id, accessToken);
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de trabajos del prestador (finalizado/cerrado)' })
  async getHistory(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.getHistory(user.id, accessToken);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de una solicitud' })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 403 })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.findOne(id, user.id, accessToken);
  }

  @Put(':id/accept')
  @ApiOperation({
    summary: 'Aceptar trabajo (solo prestadores verificados y disponibles)',
    description: 'El primer prestador que acepta se lleva el trabajo. Race-condition seguro.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Trabajo ya tomado por otro técnico' })
  @ApiResponse({ status: 403 })
  async accept(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Aceptar solicitud ${id} - prestador: ${user.id}`);
    return this.solicitudesService.accept(id, user.id, accessToken);
  }

  @Put(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancelar solicitud (solo cliente, estado buscando)',
    description: 'Permite al cliente cancelar su solicitud mientras está en estado buscando. Una vez aceptada no puede cancelarse.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'Solo se puede cancelar en estado buscando' })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Cancelar solicitud ${id} - cliente: ${user.id}`);
    return this.solicitudesService.cancel(id, user.id, accessToken);
  }

  @Put(':id/status')
  @ApiOperation({
    summary: 'Actualizar estado',
    description: 'aceptado→finalizado (prestador) | finalizado→cerrado (cliente)',
  })
  @ApiResponse({ status: 400, description: 'Transición inválida' })
  async updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: UpdateStatusDto,
  ) {
    this.logger.log(`Update status solicitud ${id} → ${dto.estado} - user: ${user.id}`);
    return this.solicitudesService.updateStatus(id, user.id, dto, accessToken);
  }
}
