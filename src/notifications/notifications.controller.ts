import { Controller, Post, Body, UseGuards, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import {
  CurrentUser,
  AccessToken,
} from '../common/decorators/current-user.decorator';
import type { User } from '@supabase/supabase-js';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(private notificationsService: NotificationsService) {}

  @Post('register-token')
  @ApiOperation({ summary: 'Register Expo push notification token' })
  @ApiResponse({ status: 201, description: 'Token registered successfully' })
  async registerToken(
    @CurrentUser() user: User,
    @AccessToken() accessToken: string,
    @Body() registerTokenDto: RegisterTokenDto,
  ) {
    this.logger.log(`Register push token for user: ${user.id}`);
    return this.notificationsService.registerToken(
      user.id,
      registerTokenDto,
      accessToken,
    );
  }
}
