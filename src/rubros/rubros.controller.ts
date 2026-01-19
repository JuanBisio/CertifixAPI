import { Controller, Get, Param, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RubrosService } from './rubros.service';

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
}