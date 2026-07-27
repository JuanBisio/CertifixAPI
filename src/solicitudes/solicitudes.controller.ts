import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
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

  @Post('foto-problema')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Subir foto del problema (previo a crear la solicitud)',
    description: 'Sube la foto a Storage y devuelve el path para incluir en fotos_urls al crear la solicitud.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiResponse({ status: 201 })
  async uploadFotoProblema(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.solicitudesService.uploadFotoProblema(user.id, file, accessToken);
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

  @Get('mis-postulaciones')
  @ApiOperation({ summary: 'Postulaciones activas del prestador en solicitudes programadas' })
  async getMisPostulaciones(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.getMisPostulaciones(user.id, accessToken);
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

  @Put(':id/postularse')
  @ApiOperation({
    summary: 'Postularse como candidato (solo solicitudes en modo programado, hasta 3 cupos)',
    description: 'El precio no se cotiza acá: se acuerda por chat con el cliente una vez postulado.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Cupo completo, ya postulado, o plazo vencido' })
  @ApiResponse({ status: 403 })
  async postularse(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Postularse a solicitud ${id} - prestador: ${user.id}`);
    return this.solicitudesService.postularse(id, user.id, accessToken);
  }

  @Get(':id/candidatos')
  @ApiOperation({
    summary: 'Candidatos de una solicitud programada',
    description: 'El cliente dueño ve los hasta 3 candidatos; un prestador candidato solo ve su propia postulación.',
  })
  async getCandidatos(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    return this.solicitudesService.getCandidatos(id, user.id, accessToken);
  }

  @Put(':id/candidatos/:candidatoId/elegir')
  @ApiOperation({ summary: 'Elegir un candidato (solo el cliente dueño de la solicitud)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'Candidato ya no disponible o ya se eligió uno' })
  async elegirCandidato(
    @Param('id') id: string,
    @Param('candidatoId') candidatoId: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Elegir candidato ${candidatoId} en solicitud ${id} - cliente: ${user.id}`);
    return this.solicitudesService.elegirCandidato(id, candidatoId, user.id, accessToken);
  }

  @Put(':id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancelar solicitud (cliente en buscando/aceptado, prestador solo en aceptado)',
    description:
      'El cliente cancela de verdad (estado cancelado); si cancela el prestador, el trabajo vuelve a buscando para que otro lo tome. ' +
      'Cancelar en aceptado suma un strike salvo que sea un trabajo no urgente cancelado dentro de las 12hs de aceptado (CAN-02/04). ' +
      '3 strikes suspenden la cuenta (CAN-03). Ya no se puede cancelar por esta vía una vez en_camino.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 400, description: 'Estado actual no cancelable' })
  @ApiResponse({ status: 403 })
  @ApiResponse({ status: 404 })
  @ApiResponse({ status: 409, description: 'El estado cambió justo antes de poder cancelarla' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Cancelar solicitud ${id} - user: ${user.id}`);
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
