import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { TRABAJOS_GRATIS_LIMITE } from '../subscriptions/subscriptions.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly expoEndpoint = 'https://exp.host/--/api/v2/push/send';

  constructor(private supabaseService: SupabaseService) {}

  async registerToken(
    userId: string,
    dto: RegisterTokenDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const now = new Date().toISOString();

    const { error } = await supabase
      .from('expo_push_tokens')
      .upsert(
        {
          user_id: userId,
          expo_push_token: dto.expo_push_token,
          updated_at: now,
          created_at: now,
        },
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

    await this.sendPush(
      valid.map((to: string) => ({ to, title, body, data: data ?? {} })),
    );
  }

  // Notifica a prestadores que coinciden por rubro Y radio PostGIS (función RPC en Supabase)
  async notifyPrestadoresParaSolicitud(
    rubroId: string,
    lon: number,
    lat: number,
    accessToken: string,
    payload: { title: string; body: string; data?: Record<string, any> },
    franjasHorarias?: string[] | null,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Llama a la función RPC que hace el match PostGIS + prestador_rubros +
    // franja horaria (HOR-02, solo aplica si la solicitud es programada y
    // manda franjasHorarias — en urgente va undefined/null y no filtra nada).
    const { data: prestadores, error } = await supabase.rpc(
      'get_prestadores_para_solicitud',
      {
        p_rubro_id: rubroId,
        p_lon: lon,
        p_lat: lat,
        p_franjas_horarias: franjasHorarias ?? null,
      },
    );

    if (error) {
      this.logger.error(
        `Error en RPC get_prestadores_para_solicitud: ${error.message} ` +
          `(code=${error.code ?? '?'}, details=${error.details ?? '?'}, hint=${error.hint ?? '?'})`,
      );
      // Fallback: mismo criterio de rubro/disponibilidad, pero replicando el
      // filtro geográfico de la RPC en TS (no hay ST_DWithin sin RPC) — evita
      // repetir el bug de la sección 3.11: notificar a todo el país si la RPC falla.
      await this.notifyPrestadoresFallback(rubroId, lon, lat, accessToken, payload);
      return;
    }

    const userIds = (prestadores ?? [])
      .map((p: any) => p.user_id)
      .filter(Boolean);

    if (!userIds.length) {
      this.logger.log('Sin prestadores disponibles en el área para notificar');
      return;
    }

    await this.notifyUsers(
      userIds,
      payload.title,
      payload.body,
      accessToken,
      payload.data,
    );
    this.logger.log(
      `Push enviado a ${userIds.length} prestadores para rubro ${rubroId}`,
    );
  }

  // Fallback si la RPC falla: mismo match por rubro/disponibilidad/suscripción,
  // pero replicando el filtro geográfico (radio_km de cada prestador) en TS,
  // ya que acá no podemos usar ST_DWithin de PostGIS.
  private async notifyPrestadoresFallback(
    rubroId: string,
    lon: number,
    lat: number,
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
      .select('id, ubicacion_base, radio_km')
      .in('id', prestadorIds)
      .eq('disponible', true)
      .eq('esta_verificado', true)
      .or(
        `suscripcion_activa.eq.true,trabajos_gratis_usados.lt.${TRABAJOS_GRATIS_LIMITE}`,
      );

    const userIds = (disponibles ?? [])
      .filter((p: any) => {
        const coords = this.parsePoint(p.ubicacion_base);
        if (!coords) return false;
        const radioKm = p.radio_km ?? 10;
        return this.distanciaKm(lon, lat, coords.lon, coords.lat) <= radioKm;
      })
      .map((p: any) => p.id);
    if (!userIds.length) return;

    await this.notifyUsers(
      userIds,
      payload.title,
      payload.body,
      accessToken,
      payload.data,
    );
  }

  // Supabase devuelve las columnas geometry como GeoJSON ({ coordinates: [lon, lat] })
  // o como WKT ("POINT(lon lat)") según el cliente/columna; soportamos ambos.
  private parsePoint(
    raw: unknown,
  ): { lon: number; lat: number } | null {
    if (!raw) return null;
    if (typeof raw === 'object' && Array.isArray((raw as any).coordinates)) {
      const [lon, lat] = (raw as any).coordinates;
      return typeof lon === 'number' && typeof lat === 'number'
        ? { lon, lat }
        : null;
    }
    if (typeof raw === 'string') {
      const match = raw.match(/POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
      if (match) return { lon: Number(match[1]), lat: Number(match[2]) };
    }
    return null;
  }

  // Distancia en km entre dos puntos lon/lat (fórmula de Haversine).
  private distanciaKm(lon1: number, lat1: number, lon2: number, lat2: number) {
    const R = 6371;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  private readonly maxPushAttempts = 3;
  private readonly pushRetryBaseDelayMs = 500;

  private async sendPush(
    messages: Array<{
      to: string;
      title: string;
      body: string;
      data?: Record<string, any>;
    }>,
  ) {
    if (!messages.length) return;

    for (let attempt = 1; attempt <= this.maxPushAttempts; attempt++) {
      try {
        const response = await fetch(this.expoEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(messages),
        });

        // 4xx (payload inválido) no se resuelve reintentando igual; solo
        // vale la pena reintentar fallas transitorias (red, 5xx de Expo).
        if (!response.ok) {
          if (response.status < 500 || attempt === this.maxPushAttempts) {
            this.logger.error(
              `Expo push falló: ${response.status} (intento ${attempt})`,
            );
            return;
          }
          throw new Error(`Expo respondió ${response.status}`);
        }

        const result = (await response.json()) as {
          data?: Array<{ status: string; message?: string }>;
        };
        result?.data?.forEach((r) => {
          if (r.status !== 'ok')
            this.logger.warn(`Expo push no-ok: ${r.message}`);
        });
        return;
      } catch (err: any) {
        if (attempt === this.maxPushAttempts) {
          this.logger.error(
            `sendPush error tras ${attempt} intentos: ${err.message}`,
          );
          return;
        }
        const delay = this.pushRetryBaseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `sendPush intento ${attempt} falló (${err.message}), reintentando en ${delay}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private isExpoToken(token: string) {
    return typeof token === 'string' && token.startsWith('ExponentPushToken[');
  }
}
