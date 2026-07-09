import {
  Controller,
  Get,
  Put,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreatePrestadorDto } from './dto/create-prestador.dto';
import { UpdateDisponibilidadDto } from './dto/update-disponibilidad.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

const fileUploadSchema = {
  schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
};

@ApiTags('Profiles')
@Controller('profiles')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class ProfilesController {
  private readonly logger = new Logger(ProfilesController.name);

  constructor(private profilesService: ProfilesService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil del usuario autenticado' })
  async getMe(@CurrentUser() user: User, @AccessToken() accessToken: string) {
    return this.profilesService.getProfile(user.id, accessToken);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Perfil público de un prestador (para el cliente)' })
  @ApiResponse({ status: 200, description: 'nombre, rating, rubros, trabajos, calificaciones — sin datos sensibles' })
  @ApiResponse({ status: 404, description: 'Perfil no encontrado' })
  async getPublicProfile(
    @Param('id') id: string,
    @AccessToken() accessToken: string,
  ) {
    return this.profilesService.getPublicProfile(id, accessToken);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Actualizar perfil propio' })
  @ApiResponse({ status: 403, description: 'Solo podés actualizar tu propio perfil' })
  async updateProfile(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profilesService.updateProfile(id, user.id, dto, accessToken);
  }

  // ─── PRESTADOR SETUP ─────────────────────────────────────────────────────

  @Post('prestador')
  @ApiOperation({ summary: 'Crear/actualizar perfil de prestador (Step 1 + 3)' })
  @ApiResponse({ status: 201 })
  async createPrestador(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: CreatePrestadorDto,
  ) {
    return this.profilesService.createOrUpdatePrestador(user.id, dto, accessToken);
  }

  @Put('prestador/disponible')
  @ApiOperation({ summary: 'Cambiar disponibilidad del prestador' })
  async updateDisponibilidad(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() body: UpdateDisponibilidadDto,
  ) {
    return this.profilesService.updateDisponibilidad(user.id, body, accessToken);
  }

  @Patch('prestador/ping')
  @ApiOperation({
    summary: 'Heartbeat de actividad del prestador',
    description: 'Llamar al abrir la app si está disponible. Previene la auto-inactividad.',
  })
  async ping(@CurrentUser() user: User, @AccessToken() accessToken: string) {
    return this.profilesService.ping(user.id, accessToken);
  }

  // ─── UPLOADS DE DOCUMENTOS ───────────────────────────────────────────────

  @Post('prestador/dni-frente')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: 'Subir foto DNI frente (obligatorio)' })
  async uploadDniFrente(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadDocumento(user.id, 'dni_frente', file, accessToken);
  }

  @Post('prestador/dni-dorso')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: 'Subir foto DNI dorso (obligatorio)' })
  async uploadDniDorso(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadDocumento(user.id, 'dni_dorso', file, accessToken);
  }

  @Post('prestador/selfie')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: 'Subir selfie con DNI — verificación biométrica' })
  async uploadSelfie(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadDocumento(user.id, 'selfie_dni', file, accessToken);
  }

  @Post('prestador/matricula')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: 'Subir matrícula profesional (opcional — distingue Técnico Premium)' })
  async uploadMatricula(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadDocumento(user.id, 'matricula', file, accessToken);
  }

  @Post('prestador/foto-perfil')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: 'Subir foto de perfil profesional' })
  async uploadFotoPerfil(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadDocumento(user.id, 'foto_perfil', file, accessToken);
  }

  // Retrocompatibilidad con el endpoint anterior
  @Post('prestador/certificacion')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(fileUploadSchema)
  @ApiOperation({ summary: '[Deprecated] Usar /prestador/matricula' })
  async uploadCertificacion(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Archivo requerido');
    return this.profilesService.uploadCertificacion(user.id, file, accessToken);
  }
}
