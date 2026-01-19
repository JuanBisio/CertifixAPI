import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
  Logger,
  Post as HttpPost,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { SolicitudesService } from './solicitudes.service';
import { CreateSolicitudDto } from './dto/create-solicitud.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';
import { CreatePostulacionDto } from './dto/create-postulacion.dto';

@ApiTags('Solicitudes (Work Requests)')
@Controller('solicitudes')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SolicitudesController {
  private readonly logger = new Logger(SolicitudesController.name);

  constructor(private solicitudesService: SolicitudesService) {}

  @Post()
  @ApiOperation({ summary: 'Create work request (cliente only)' })
  @ApiResponse({ status: 201, description: 'Work request created successfully' })
  @ApiResponse({ status: 403, description: 'Only clientes can create work requests' })
  async create(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() createSolicitudDto: CreateSolicitudDto,
  ) {
    this.logger.log(`Create solicitud request by user: ${user.id}`);
    return this.solicitudesService.create(user.id, createSolicitudDto, accessToken);
  }

  @Get()
  @ApiOperation({ 
    summary: 'List work requests',
    description: 'Clientes see their own requests. Verified prestadores see available jobs matching their rubro.'
  })
  @ApiResponse({ status: 200, description: 'Work requests retrieved successfully' })
  async findAll(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get solicitudes request by user: ${user.id}`);
    return this.solicitudesService.findAll(user.id, accessToken);
  }

  @Get('my-active')
  @ApiOperation({ 
    summary: 'Get active work for prestador',
    description: 'Returns the active work request assigned to the prestador'
  })
  @ApiResponse({ status: 200, description: 'Active work retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Only prestadores can access this endpoint' })
  async getMyActive(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get active work request by prestador: ${user.id}`);
    return this.solicitudesService.getMyActive(user.id, accessToken);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific work request' })
  @ApiResponse({ status: 200, description: 'Work request retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Work request not found' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get solicitud ${id} by user: ${user.id}`);
    return this.solicitudesService.findOne(id, user.id, accessToken);
  }

  @HttpPost(':id/postulaciones')
  @ApiOperation({ summary: 'Postularse a un trabajo (prestador)' })
  async createPostulacion(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() createPostulacionDto: CreatePostulacionDto,
  ) {
    this.logger.log(`Postulación para trabajo ${id} por prestador ${user.id}`);
    return this.solicitudesService.createPostulacion(id, user.id, createPostulacionDto, accessToken);
  }

  @Get(':id/postulaciones')
  @ApiOperation({ summary: 'Listar postulaciones (solo cliente dueño del trabajo)' })
  async listPostulaciones(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`List postulaciones para trabajo ${id} por usuario ${user.id}`);
    return this.solicitudesService.listPostulaciones(id, user.id, accessToken);
  }

  @Put(':id/seleccionar/:postulacionId')
  @ApiOperation({ summary: 'Seleccionar postulante ganador (cliente)' })
  async seleccionarPostulante(
    @Param('id') id: string,
    @Param('postulacionId') postulacionId: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Seleccionar postulacion ${postulacionId} para trabajo ${id} por usuario ${user.id}`);
    return this.solicitudesService.seleccionarPostulante(id, postulacionId, user.id, accessToken);
  }

  @Put(':id/status')
  @ApiOperation({ 
    summary: 'Update request status',
    description: 'Valid transitions: buscando→aceptado (solo cliente), aceptado→finalizado, finalizado→cerrado'
  })
  @ApiResponse({ status: 200, description: 'Status updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid state transition' })
  async updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() updateStatusDto: UpdateStatusDto,
  ) {
    this.logger.log(`Update status for solicitud ${id} by user: ${user.id}`);
    return this.solicitudesService.updateStatus(id, user.id, updateStatusDto, accessToken);
  }
}
