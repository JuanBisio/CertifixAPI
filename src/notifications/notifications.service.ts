import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterTokenDto } from './dto/register-token.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expoEndpoint = 'https://exp.host/--/api/v2/push/send';

  constructor(private supabaseService: SupabaseService) {}

  async registerToken(
    userId: string,
    registerTokenDto: RegisterTokenDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const now = new Date().toISOString();

      const { error } = await supabase
        .from('expo_push_tokens')
        .upsert(
          {
            user_id: userId,
            expo_push_token: registerTokenDto.expo_push_token,
            updated_at: now,
            created_at: now,
          },
          {
            onConflict: 'user_id',
            ignoreDuplicates: false,
          },
        )
        .select('id')
        .single();

      if (error) {
        this.logger.error(`Failed to save push token: ${error.message}`);
        throw new BadRequestException('Failed to register push token');
      }

      this.logger.log(`Push token stored for user ${userId}`);
      return {
        message: 'Push token registered successfully',
        token: registerTokenDto.expo_push_token,
      };
    } catch (error) {
      this.logger.error(`Register token error: ${error.message}`);
      throw new BadRequestException('Failed to register push token');
    }
  }

  async notifyUsers(
    userIds: string[],
    title: string,
    body: string,
    accessToken: string,
    data?: Record<string, any>,
  ) {
    if (!userIds.length) return;
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { data: tokens, error } = await supabase
        .from('expo_push_tokens')
        .select('expo_push_token')
        .in('user_id', userIds);

      if (error) {
        if (error.message?.includes('expo_push_tokens')) {
          this.logger.warn('Push tokens table missing; skip push.');
          return;
        }
        this.logger.error(`Failed to fetch push tokens: ${error.message}`);
        return;
      }

      const validTokens =
        tokens
          ?.map((t) => t.expo_push_token)
          .filter((token) => this.isExpoToken(token)) || [];

      await this.sendPushNotifications(
        validTokens.map((token) => ({
          to: token,
          title,
          body,
          data: data || {},
        })),
      );
    } catch (error) {
      this.logger.error(`notifyUsers error: ${error.message}`);
    }
  }

  async notifyPrestadoresForRubro(
    rubroId: string,
    accessToken: string,
    payload: { title: string; body: string; data?: Record<string, any> },
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      const { data: prestadores, error } = await supabase
        .from('perfiles_prestadores')
        .select('user_id')
        .eq('rubro_id', rubroId)
        .eq('disponible', true)
        .eq('esta_verificado', true);

      if (error) {
        if (error.message?.includes('expo_push_tokens')) {
          this.logger.warn('Push tokens table missing; skip push.');
          return;
        }
        this.logger.error(`Failed to fetch prestadores for push: ${error.message}`);
        return;
      }

      const userIds =
        prestadores
          ?.map((p: any) => p.user_id)
          .filter((id: string | undefined) => !!id) || [];

      if (!userIds.length) {
        this.logger.log('No prestadores disponibles para notificar.');
        return;
      }

      await this.notifyUsers(
        userIds,
        payload.title,
        payload.body,
        accessToken,
        payload.data,
      );
    } catch (error) {
      this.logger.error(`notifyPrestadoresForRubro error: ${error.message}`);
    }
  }

  private async sendPushNotifications(
    messages: Array<{ to: string; title: string; body: string; data?: Record<string, any> }>,
  ) {
    if (!messages.length) {
      return;
    }

    try {
      const response = await fetch(this.expoEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Expo push failed: ${response.status} - ${errorText}`);
        return;
      }

      const result = (await response.json()) as { data?: Array<{ status: string; message?: string }> };
      result?.data?.forEach((r) => {
        if (r.status !== 'ok') {
          this.logger.warn(`Expo push ticket returned non-ok status: ${r.message}`);
        }
      });
    } catch (error) {
      this.logger.error(`sendPushNotifications error: ${error.message}`);
    }
  }

  private isExpoToken(token: string) {
    return typeof token === 'string' && token.startsWith('ExponentPushToken[');
  }
}
