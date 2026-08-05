import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import WebSocket from 'ws';

@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;
  private serviceClient?: SupabaseClient;

  constructor(private configService: ConfigService) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_ANON_KEY');
    const serviceRoleKey = this.configService.get<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Missing Supabase credentials in environment variables');
    }

    this.logger.log(
      `Service role key loaded: ${serviceRoleKey ? 'yes' : 'no'}`,
    );

    const realtimeOpts = { transport: WebSocket as any };
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      realtime: realtimeOpts,
    });
    if (serviceRoleKey) {
      this.serviceClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
        realtime: realtimeOpts,
      });
      this.logger.log('Supabase service-role client initialized');
    } else {
      // Throw error to debug if key is not being loaded
      throw new Error(
        'CRITICAL: SUPABASE_SERVICE_ROLE_KEY is missing. Backend cannot bypass RLS.',
      );
    }
    this.logger.log('Supabase client initialized');
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  // Admin client to bypass RLS when service role key is provided
  getServiceClient(): SupabaseClient {
    return this.serviceClient || this.supabase;
  }

  // Helper to get authenticated client with user's JWT
  getAuthenticatedClient(accessToken: string): SupabaseClient {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL')!;
    const supabaseKey = this.configService.get<string>('SUPABASE_ANON_KEY')!;

    return createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
      realtime: { transport: WebSocket as any },
    });
  }

  async verifyToken(token: string): Promise<User | null> {
    try {
      const {
        data: { user },
        error,
      } = await this.supabase.auth.getUser(token);

      if (error) {
        this.logger.error(`Token verification failed: ${error.message}`);
        return null;
      }

      return user;
    } catch (error) {
      this.logger.error(`Token verification error: ${error.message}`);
      return null;
    }
  }
}
