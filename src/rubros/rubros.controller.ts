import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RubrosService } from './rubros.service';
import { CreateRubroDto } from './dto/create-rubro.dto';
import { UpdateRubroDto } from './dto/update-rubro.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@ApiTags('Rubros')
@Controller('rubros')
export class RubrosController {
  private readonly logger = new Logger(RubrosController.name);

  constructor(private rubrosService: RubrosService) {}

  @Get()
  @ApiOperation({ summary: 'List all service categories (rubros)' })
  @ApiResponse({ status: 200, description: 'Rubros retrieved successfully' })
  async findAll() {
    this.logger.log('Get all rubros request');
    return this.rubrosService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get specific rubro by ID' })
  @ApiResponse({ status: 200, description: 'Rubro retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Rubro not found' })
  async findOne(@Param('id') id: string) {
    this.logger.log(`Get rubro request: ${id}`);
    return this.rubrosService.findOne(id);
  }

  // ─── RQ-02: ABM de rubros (solo admin) ───────────────────────────────────

  @Post()
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Crear un rubro nuevo (solo admin)' })
  @ApiResponse({ status: 201 })
  async create(@Body() dto: CreateRubroDto) {
    this.logger.log(`Crear rubro: ${dto.nombre}`);
    return this.rubrosService.create(dto);
  }

  @Patch(':id')
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Editar un rubro (solo admin)' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'Rubro not found' })
  async update(@Param('id') id: string, @Body() dto: UpdateRubroDto) {
    this.logger.log(`Actualizar rubro: ${id}`);
    return this.rubrosService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(SupabaseAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Borrar un rubro (solo admin, falla si está en uso)',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 400,
    description: 'Rubro en uso por solicitudes o prestadores',
  })
  async remove(@Param('id') id: string) {
    this.logger.log(`Eliminar rubro: ${id}`);
    return this.rubrosService.remove(id);
  }
}
