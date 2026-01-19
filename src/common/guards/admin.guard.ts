import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);

  constructor(private supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const accessToken = request.accessToken as string | undefined;

    if (!user || !accessToken) {
      this.logger.warn('Missing user or access token in admin guard');
      throw new ForbiddenException('Access denied');
    }

    // Dev bypass (set ADMIN_BYPASS=true in env to skip admin check)
    if (process.env.ADMIN_BYPASS === 'true') {
      this.logger.warn('ADMIN_BYPASS enabled: skipping admin check');
      return true;
    }

    try {
      // Check Supabase auth role in JWT (app_metadata roles or role)
      const appMeta = (user as any).app_metadata || {};
      const roles = (appMeta.roles as string[]) || [];
      const singleRole = (appMeta.role as string) || (user as any).role;

      const isAdminRole =
        roles.map((r) => r?.toLowerCase()).includes('admin') ||
        (singleRole && singleRole.toLowerCase() === 'admin');

      if (isAdminRole) {
        return true;
      }

      // Fallback: allow list from env (comma-separated emails)
      const allowList =
        process.env.ADMIN_EMAILS?.split(',').map((e) => e.trim().toLowerCase()) || [];
      if (user.email && allowList.includes(user.email.toLowerCase())) {
        this.logger.log(`Admin access granted via allowlist for ${user.email}`);
        return true;
      }

      throw new ForbiddenException('Admin access required');
    } catch (error: any) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.error(`Admin guard error: ${error.message}`);
      throw new ForbiddenException('Admin access required');
    }
  }
}
