import { Controller, Get, Patch, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IsBoolean, IsOptional, IsIn } from 'class-validator';
import type { Request } from 'express';

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

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(SupabaseAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private adminService: AdminService) {}

  @Get('prestadores')
  async listPrestadores(@Query() query: ListPrestadoresQuery, @Req() req: Request) {
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
    return this.adminService.setVerificado(accessToken, id, dto.value, dto.tipo_verificacion);
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

  @Get('prestadores/:id/documentos')
  async getDocumentosPrestador(@Param('id') id: string) {
    return this.adminService.getDocumentosPrestador(id);
  }

  @Patch('prestadores/:id/reject')
  async rejectPrestador(@Param('id') id: string, @Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.rejectPrestador(accessToken, id);
  }

  @Patch('prestadores/:id/baja')
  async darDeBajaPrestador(@Param('id') id: string, @Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.darDeBajaPrestador(accessToken, id);
  }

  @Get('suscripciones')
  async listSuscripciones(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listSuscripciones(accessToken);
  }

  @Get('payments')
  async listPayments(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listPayments(accessToken);
  }

  @Get('disputas')
  async listDisputas(@Req() req: Request) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.listDisputas(accessToken);
  }

  @Patch('disputas/:id/resolve')
  async resolveDisputa(
    @Param('id') id: string,
    @Body() dto: { resolution: string },
    @Req() req: Request,
  ) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.resolveDisputa(accessToken, id, dto.resolution);
  }
}
