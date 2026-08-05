import {
  Controller,
  Get,
  Post,
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
import { EvidenciasService } from './evidencias.service';
import { CreateEvidenciaDto } from './dto/create-evidencia.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AccessToken,
} from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Evidencias (Evidence)')
@Controller('evidencias')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class EvidenciasController {
  private readonly logger = new Logger(EvidenciasController.name);

  constructor(private evidenciasService: EvidenciasService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload evidence file for work request' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['trabajo_id', 'es_reclamo', 'file'],
      properties: {
        trabajo_id: { type: 'string', format: 'uuid' },
        es_reclamo: { type: 'boolean' },
        comentario: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Evidence uploaded successfully' })
  async create(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() createEvidenciaDto: CreateEvidenciaDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    this.logger.log(
      `Upload evidence for trabajo: ${createEvidenciaDto.trabajo_id}`,
    );
    return this.evidenciasService.create(
      user.id,
      createEvidenciaDto,
      file,
      accessToken,
    );
  }

  @Get(':trabajoId')
  @ApiOperation({ summary: 'Get evidence for work request' })
  @ApiResponse({ status: 200, description: 'Evidence retrieved successfully' })
  @ApiResponse({ status: 403, description: 'Access denied' })
  async findByTrabajo(
    @Param('trabajoId') trabajoId: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get evidence for trabajo: ${trabajoId}`);
    return this.evidenciasService.findByTrabajo(
      trabajoId,
      user.id,
      accessToken,
    );
  }
}
