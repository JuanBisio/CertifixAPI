import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { TRABAJOS_GRATIS_LIMITE } from '../subscriptions/subscriptions.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expoEndpoint = 'https://exp.host/--/api/v2/push/send';

  constructor(private supabaseService: SupabaseService) {}

  async registerToken(userId: string, dto: RegisterTokenDto, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('expo_push_tokens')
      .upsert(
        { user_id: userId, expo_push_token: dto.expo_push_token, updated_at: now, created_at: now },
        { onConflict: 'user_id', ignoreDuplicates: false },
      )
      .select('id')
      .single();

    if (error) {
      this.logger.error(`Error guardando push token: ${error.message}`);
      throw new BadRequestException('No se pudo registrar el push token');
    }

    return { message: 'Push token registrado', token: dto.expo_push_token };
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

    const { data: tokens, error } = await supabase
      .from('expo_push_tokens')
      .select('expo_push_token')
      .in('user_id', userIds);

    if (error) {
      this.logger.error(`Error obteniendo push tokens: ${error.message}`);
      return;
    }

    const valid = (tokens ?? [])
      .map((t: any) => t.expo_push_token)
      .filter(this.isExpoToken);

    await this.sendPush(valid.map((to: string) => ({ to, title, body, data: data ?? {} })));
  }

  // Notifica a prestadores que coinciden por rubro Y radio PostGIS (función RPC en Supabase)
  async notifyPrestadoresParaSolicitud(
    rubroId: string,
    lon: number,
    lat: number,
    accessToken: string,
    payload: { title: string; body: string; data?: Record<string, any> },
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Llama a la función RPC que hace el match PostGIS + prestador_rubros
    const { data: prestadores, error } = await supabase.rpc(
      'get_prestadores_para_solicitud',
      { p_rubro_id: rubroId, p_lon: lon, p_lat: lat },
    );

    if (error) {
      this.logger.error(`Error en RPC get_prestadores_para_solicitud: ${error.message}`);
      // Fallback: notificar por rubro sin filtro geográfico si la función no existe aún
      await this.notifyPrestadoresFallback(rubroId, accessToken, payload);
      return;
    }

    const userIds = (prestadores ?? []).map((p: any) => p.user_id).filter(Boolean);

    if (!userIds.length) {
      this.logger.log('Sin prestadores disponibles en el área para notificar');
      return;
    }

    await this.notifyUsers(userIds, payload.title, payload.body, accessToken, payload.data);
    this.logger.log(`Push enviado a ${userIds.length} prestadores para rubro ${rubroId}`);
  }

  // Fallback: match solo por rubro (sin PostGIS) — usado durante migración
  private async notifyPrestadoresFallback(
    rubroId: string,
    accessToken: string,
    payload: { title: string; body: string; data?: Record<string, any> },
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: prestadores, error } = await supabase
      .from('prestador_rubros')
      .select('prestador_id')
      .eq('rubro_id', rubroId);

    if (error || !prestadores?.length) return;

    const prestadorIds = prestadores.map((p: any) => p.prestador_id);

    const { data: disponibles } = await supabase
      .from('perfiles_prestadores')
      .select('id')
      .in('id', prestadorIds)
      .eq('disponible', true)
      .eq('esta_verificado', true)
      .or(`suscripcion_activa.eq.true,trabajos_gratis_usados.lt.${TRABAJOS_GRATIS_LIMITE}`);

    const userIds = (disponibles ?? []).map((p: any) => p.id);
    if (!userIds.length) return;

    await this.notifyUsers(userIds, payload.title, payload.body, accessToken, payload.data);
  }

  private async sendPush(
    messages: Array<{ to: string; title: string; body: string; data?: Record<string, any> }>,
  ) {
    if (!messages.length) return;

    try {
      const response = await fetch(this.expoEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        this.logger.error(`Expo push falló: ${response.status}`);
        return;
      }

      const result = (await response.json()) as { data?: Array<{ status: string; message?: string }> };
      result?.data?.forEach((r) => {
        if (r.status !== 'ok') this.logger.warn(`Expo push no-ok: ${r.message}`);
      });
    } catch (err: any) {
      this.logger.error(`sendPush error: ${err.message}`);
    }
  }

  private isExpoToken(token: string) {
    return typeof token === 'string' && token.startsWith('ExponentPushToken[');
  }
}
