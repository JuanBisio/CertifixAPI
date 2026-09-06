import {
  Controller,
  Post,
  Put,
  Get,
  Body,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AccessToken,
} from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private authService: AuthService) {}

  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async register(@Body() registerDto: RegisterDto) {
    this.logger.log(`Registration attempt for email: ${registerDto.email}`);
    return this.authService.register(registerDto);
  }

  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Login user' })
  @ApiResponse({ status: 200, description: 'User logged in successfully' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() loginDto: LoginDto) {
    this.logger.log(`Login attempt for email: ${loginDto.email}`);
    return this.authService.login(loginDto);
  }

  @Post('logout')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'User logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@AccessToken() accessToken: string) {
    this.logger.log('Logout request');
    return this.authService.logout(accessToken);
  }

  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({
    status: 200,
    description: 'User profile retrieved successfully',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Get current user request: ${user.id}`);
    return this.authService.getCurrentUser(user.id, accessToken);
  }

  @Put('change-password')
  @UseGuards(SupabaseAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cambiar la contraseña del usuario autenticado (requiere la actual)',
  })
  @ApiResponse({ status: 200, description: 'Contraseña actualizada' })
  @ApiResponse({ status: 401, description: 'Contraseña actual incorrecta' })
  async changePassword(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() dto: ChangePasswordDto,
  ) {
    this.logger.log(`Change password request: ${user.id}`);
    return this.authService.changePassword(user.email!, accessToken, dto);
  }

  @Post('account/delete-request')
  @UseGuards(SupabaseAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Solicitar eliminación real de la cuenta (irreversible) — bloquea el login y programa la supresión de datos a los 30 días',
  })
  @ApiResponse({
    status: 200,
    description: 'Solicitud de eliminación registrada',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async requestAccountDeletion(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
  ) {
    this.logger.log(`Account deletion requested: ${user.id}`);
    return this.authService.requestAccountDeletion(user.id, accessToken);
  }
}
