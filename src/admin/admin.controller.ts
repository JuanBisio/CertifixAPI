import { Controller, Get, Patch, Param, Body, Query, UseGuards, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { IsBoolean, IsOptional } from 'class-validator';
import type { Request } from 'express';

class UpdateFlagDto {
  @IsBoolean()
  value: boolean;
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
    @Body() dto: UpdateFlagDto,
    @Req() req: Request,
  ) {
    const accessToken = (req as any).accessToken as string;
    return this.adminService.setVerificado(accessToken, id, dto.value);
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
}
