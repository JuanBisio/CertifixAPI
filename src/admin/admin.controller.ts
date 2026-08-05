import {
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  IsBoolean,
  IsOptional,
  IsIn,
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Max,
  IsNumber,
} from 'class-validator';
import type { Request } from 'express';
import { ListSolicitudesQuery } from './dto/list-solicitudes.dto';

class UpdateFlagDto {
  @IsBoolean()
  @ApiProperty()
  value: boolean;
}

class VerifyPrestadorDto {
  @IsBoolean()
  @ApiProperty()
  value: boolean;

  @IsOptional()
  @IsIn(['estandar', 'premium'])
  @ApiPropertyOptional({ enum: ['estandar', 'premium'] })
  tipo_verificacion?: 'estandar' | 'premium';
}

class ListPrestadoresQuery {
  @IsOptional()
  @IsBoolean()
  verificado?: boolean;
}

class BajaPrestadorDto {
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  confirmar_con_trabajo_activo?: boolean;
}

class ResolveDisputaDto {
  @IsIn(['a_favor_cliente', 'a_favor_prestador'])
  @ApiProperty({ enum: ['a_favor_cliente', 'a_favor_prestador'] })
  resolution: 'a_favor_cliente' | 'a_favor_prestador';

  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  nota: string;
}

class ProcesarRevocacionDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  nota_admin: string;
}

class ExtenderSuscripcionDto {
  @IsInt()
  @Min(1)
  @Max(365)
  @ApiProperty()
  dias: number;
}

class PagoOfflineDto {
  @IsString()
  @IsNotEmpty()
  @ApiProperty()
  metodo: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @ApiPropertyOptional()
  monto?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  @ApiPropertyOptional()
  dias?: number;

  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  nota?: string;
}

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get('metrics')
  async getMetrics() {
    return this.adminService.getMetrics();
  }

  @Get('prestadores')
  async listPrestadores(
    @Query() query: ListPrestadoresQuery,
    @Req() req: Request,
  ) {
    const accessToken = (req as any).accessToken as string;
    const verificado = query.verificado;
    return this.adminService.listPrestadores(accessToken, verificado);
  }

  @Patch('prestadores/:id/verify')
  async verifyPrestador(
    @Param('id') id: string,
    @Body() dto: VerifyPrestadorDto,
    @Req() req: Request,
  ) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.setVerificado(
      accessToken,
      id,
      dto.value,
      dto.tipo_verificacion,
    );
  }

  @Patch('prestadores/:id/disponible')
  async disponiblePrestador(
    @Param('id') id: string,
    @Body() dto: UpdateFlagDto,
    @Req() req: Request,
  ) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.setDisponible(accessToken, id, dto.value);
  }

  @Patch('prestadores/:id/rc-verificado')
  async setRcVerificado(@Param('id') id: string, @Body() dto: UpdateFlagDto) {
    return this.adminService.setRcVerificado(id, dto.value);
  }

  @Get('prestadores/:id/documentos')
  async getDocumentosPrestador(@Param('id') id: string) {
    return this.adminService.getDocumentosPrestador(id);
  }

  @Get('prestadores/:id/historial')
  async getHistorialPrestador(@Param('id') id: string) {
    return this.adminService.getHistorialPrestador(id);
  }

  @Patch('prestadores/:id/reject')
  async rejectPrestador(@Param('id') id: string, @Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.rejectPrestador(accessToken, id);
  }

  @Patch('prestadores/:id/baja')
  async darDeBajaPrestador(
    @Param('id') id: string,
    @Body() dto: BajaPrestadorDto,
  ) {
    return this.adminService.darDeBajaPrestador(
      id,
      !!dto.confirmar_con_trabajo_activo,
    );
  }

  @Get('suscripciones')
  async listSuscripciones(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listSuscripciones(accessToken);
  }

  @Get('prestadores/:id/pagos')
  async getPagosPrestador(@Param('id') id: string) {
    return this.adminService.getPagosPrestador(id);
  }

  @Patch('prestadores/:id/suscripcion/extender')
  async extenderSuscripcion(
    @Param('id') id: string,
    @Body() dto: ExtenderSuscripcionDto,
  ) {
    return this.adminService.extenderSuscripcion(id, dto.dias);
  }

  @Post('prestadores/:id/suscripcion/pago-offline')
  async registrarPagoOffline(
    @Param('id') id: string,
    @Body() dto: PagoOfflineDto,
    @Req() req: Request,
  ) {
    const adminEmail = (req as any).user?.email as string | undefined;
    return this.adminService.registrarPagoOffline(id, dto, adminEmail);
  }

  @Get('disputas')
  async listDisputas(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listDisputas(accessToken);
  }

  @Get('disputas/:id')
  async getDisputaDetail(@Param('id') id: string) {
    return this.adminService.getDisputaDetail(id);
  }

  @Patch('disputas/:id/resolve')
  async resolveDisputa(
    @Param('id') id: string,
    @Body() dto: ResolveDisputaDto,
  ) {
    return this.adminService.resolveDisputa(id, dto.resolution, dto.nota);
  }

  @Patch('disputas/:id/reopen')
  async reopenDisputa(@Param('id') id: string) {
    return this.adminService.reopenDisputa(id);
  }

  @Get('revocaciones')
  async listRevocaciones(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listRevocaciones(accessToken);
  }

  @Get('revocaciones/:id')
  async getRevocacionDetail(@Param('id') id: string) {
    return this.adminService.getRevocacionDetail(id);
  }

  @Patch('revocaciones/:id/procesar')
  async procesarRevocacion(
    @Param('id') id: string,
    @Body() dto: ProcesarRevocacionDto,
    @Req() req: Request,
  ) {
    const adminEmail = (req as any).user?.email as string | undefined;
    return this.adminService.procesarRevocacion(id, dto.nota_admin, adminEmail);
  }

  @Get('solicitudes')
  async listSolicitudes(@Query() query: ListSolicitudesQuery) {
    return this.adminService.listSolicitudes(query);
  }

  @Get('solicitudes/:id')
  async getSolicitudDetail(@Param('id') id: string) {
    return this.adminService.getSolicitudDetail(id);
  }
}
