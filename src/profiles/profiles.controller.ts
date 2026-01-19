import {
  Controller,
  Get,
  Put,
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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreatePrestadorDto } from './dto/create-prestador.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { CurrentUser, AccessToken } from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';
import { UpdateDisponibilidadDto } from './dto/update-disponibilidad.dto';

@ApiTags('Profiles')
@Controller('profiles')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class ProfilesController {
  private readonly logger = new Logger(ProfilesController.name);

  constructor(private profilesService: ProfilesService) {}

  @Put(':id')
  @ApiOperation({ summary: 'Update user profile (own profile only)' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden - can only update own profile' })
  async updateProfile(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    this.logger.log(`Update profile request: ${id}`);
    return this.profilesService.updateProfile(id, user.id, updateProfileDto, accessToken);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  async getMe(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get current profile: ${user.id}`);
    return this.profilesService.getProfile(user.id, accessToken);
  }

  @Post('prestador')
  @ApiOperation({ summary: 'Create or update prestador profile' })
  @ApiResponse({ status: 201, description: 'Prestador profile created/updated successfully' })
  async createPrestador(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() createPrestadorDto: CreatePrestadorDto,
  ) {
    this.logger.log(`Create/update prestador request: ${user.id}`);
    return this.profilesService.createOrUpdatePrestador(user.id, createPrestadorDto, accessToken);
  }

  @Put('prestador/disponible')
  @ApiOperation({ summary: 'Toggle prestador availability (self)' })
  @ApiResponse({ status: 200, description: 'Availability updated' })
  async updateDisponibilidad(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() body: UpdateDisponibilidadDto,
  ) {
    this.logger.log(`Update disponibilidad: ${user.id} -> ${body.disponible}`);
    return this.profilesService.updateDisponibilidad(user.id, { disponible: body.disponible }, accessToken);
  }

  @Post('prestador/certificacion')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload prestador certification file' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Certification uploaded successfully' })
  async uploadCertificacion(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    this.logger.log(`Upload certification request: ${user.id}`);
    return this.profilesService.uploadCertificacion(user.id, file, accessToken);
  }
}
