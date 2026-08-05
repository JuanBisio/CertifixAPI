import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(private supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      this.logger.warn('Missing or invalid authorization header');
      throw new UnauthorizedException('Missing or invalid authorization token');
    }

    const token = authHeader.substring(7);

    try {
      const user = await this.supabaseService.verifyToken(token);

      if (!user) {
        throw new UnauthorizedException('Invalid token');
      }

      // Attach user and token to request
      request.user = user;
      request.accessToken = token;

      this.logger.log(`User authenticated: ${user.id}`);
      return true;
    } catch (error) {
      this.logger.error(`Authentication error: ${error.message}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }
}
