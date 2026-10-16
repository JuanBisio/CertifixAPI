import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import { TRABAJOS_GRATIS_LIMITE } from '../subscriptions/subscriptions.service';
import { distanciaKm, parsePoint } from '../common/utils/geo.util';

export interface NotificarRondaParams {
  solicitudId: string;
  rubroId: string;
  lon: number;
  lat: number;
  payload: { title: string; body: string; data?: Record<string, any> };
  franjasHorarias?: string[] | null;
  /** Número de ronda (1..N) — solo se usa para registrar y loguear. */
  ronda: number;
  /** Radio de esta ronda, en km (ver src/solicitudes/matching-rondas.ts). */
  radioKm: number;
  /** Última ronda: el radio de la ronda pisa el `radio_km` del prestador. */
  ignorarRadioPrestador: boolean;
}

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

  /**
   * Busca los tokens de los destinatarios y les manda el push.
   *
   * La lectura de `expo_push_tokens` va SIEMPRE con el service client, nunca
   * con el JWT del que dispara la notificación: la policy RLS de esa tabla es
   * `user_id = auth.uid()` FOR ALL (migrations/create_expo_push_tokens.sql),
   * así que con el token del actor esta query devuelve, como mucho, el token
   * del propio actor — cero filas para cualquier push dirigido a otra persona.
   * Quién puede notificar a quién ya lo decide el caller; acá solo se resuelve
   * el token, que es una operación de sistema.
   */
  async notifyUsers(
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, any>,
  ) {
    if (!userIds.length) return;
    const supabase = this.supabaseService.getServiceClient();

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

  /**
   * SOL-04 — notifica UNA ronda de matching de una solicitud: prestadores del
   * rubro dentro del radio de la ronda (PostGIS vía RPC), excluyendo a los que
   * ya recibieron el push en una ronda anterior.
   *
   * Devuelve cuántos prestadores NUEVOS se notificaron: el motor de rondas
   * (SolicitudesTimeoutService) usa ese número para decidir cuánto esperar
   * antes de ampliar.
   */
  async notifyPrestadoresParaSolicitud(
    params: NotificarRondaParams,
  ): Promise<number> {
    const {
      solicitudId,
      rubroId,
      lon,
      lat,
      payload,
      franjasHorarias,
      ronda,
      radioKm,
      ignorarRadioPrestador,
    } = params;

    // Todo el camino de matching usa el service client: corre tanto desde
    // create() (con un cliente logueado) como desde el cron (sin ningún JWT),
    // y decide a quién notificar, no lee datos "en nombre de" nadie.
    const supabase = this.supabaseService.getServiceClient();

    const yaNotificados = await this.prestadoresYaNotificados(solicitudId);

    const { data: prestadores, error } = await supabase.rpc(
      'get_prestadores_para_solicitud',
      {
        p_rubro_id: rubroId,
        p_lon: lon,
        p_lat: lat,
        // HOR-02: solo el modo programado manda franja; en urgente va null y
        // no filtra nada.
        p_franjas_horarias: franjasHorarias ?? null,
        p_radio_km: radioKm,
        p_ignorar_radio_prestador: ignorarRadioPrestador,
        p_excluir_prestadores: yaNotificados.length ? yaNotificados : null,
      },
    );

    let userIds: string[];

    if (error) {
      this.logger.error(
        `Error en RPC get_prestadores_para_solicitud: ${error.message} ` +
          `(code=${error.code ?? '?'}, details=${error.details ?? '?'}, hint=${error.hint ?? '?'})`,
      );
      // Fallback: mismo criterio de rubro/disponibilidad y MISMO criterio de
      // radio de ronda, replicando el filtro geográfico en TS (no hay
      // ST_DWithin sin RPC) — evita repetir el bug de la sección 3.11/3.12:
      // notificar a todo el país si la RPC falla.
      userIds = await this.prestadoresFallback(
        rubroId,
        lon,
        lat,
        radioKm,
        ignorarRadioPrestador,
        yaNotificados,
      );
    } else {
      userIds = (prestadores ?? []).map((p: any) => p.user_id).filter(Boolean);
    }

    if (!userIds.length) {
      this.logger.log(
        `Ronda ${ronda} (${radioKm} km) de la solicitud ${solicitudId}: ` +
          `sin prestadores nuevos para notificar`,
      );
      return 0;
    }

    await this.registrarNotificados(solicitudId, userIds, ronda);

    await this.notifyUsers(userIds, payload.title, payload.body, payload.data);
    this.logger.log(
      `Ronda ${ronda} (${radioKm} km${ignorarRadioPrestador ? ', rescate' : ''}) ` +
        `de la solicitud ${solicitudId}: push a ${userIds.length} prestadores del rubro ${rubroId}`,
    );
    return userIds.length;
  }

  /** Prestadores que ya recibieron el push de esta solicitud en alguna ronda. */
  private async prestadoresYaNotificados(
    solicitudId: string,
  ): Promise<string[]> {
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('solicitud_notificaciones')
      .select('prestador_id')
      .eq('solicitud_id', solicitudId);

    if (error) {
      // Si esto falla preferimos re-notificar (molesto) antes que no notificar
      // a nadie (funcionalmente roto), pero tiene que verse en los logs.
      this.logger.error(
        `Error leyendo solicitud_notificaciones de ${solicitudId}: ${error.message} ` +
          `(code=${(error as any).code ?? '?'}, details=${(error as any).details ?? '?'}, hint=${(error as any).hint ?? '?'})`,
      );
      return [];
    }
    return (data ?? []).map((r: any) => r.prestador_id).filter(Boolean);
  }

  private async registrarNotificados(
    solicitudId: string,
    prestadorIds: string[],
    ronda: number,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const { error } = await supabase.from('solicitud_notificaciones').upsert(
      prestadorIds.map((prestadorId) => ({
        solicitud_id: solicitudId,
        prestador_id: prestadorId,
        ronda,
      })),
      { onConflict: 'solicitud_id,prestador_id', ignoreDuplicates: true },
    );

    if (error) {
      this.logger.error(
        `Error registrando notificados de la solicitud ${solicitudId} ` +
          `(ronda ${ronda}): ${error.message} (code=${(error as any).code ?? '?'}, ` +
          `details=${(error as any).details ?? '?'}, hint=${(error as any).hint ?? '?'})`,
      );
    }
  }

  /**
   * Fallback si la RPC falla: mismo match por rubro/disponibilidad/suscripción,
   * replicando en TS el radio efectivo de la ronda (ver `radioEfectivoKm()` en
   * src/solicitudes/matching-rondas.ts, mismo criterio que el CASE del RPC y
   * que el filtro Haversine de SolicitudesService.findAll()).
   */
  private async prestadoresFallback(
    rubroId: string,
    lon: number,
    lat: number,
    radioKm: number,
    ignorarRadioPrestador: boolean,
    excluir: string[],
  ): Promise<string[]> {
    const supabase = this.supabaseService.getServiceClient();

    const { data: prestadores, error } = await supabase
      .from('prestador_rubros')
      .select('prestador_id')
      .eq('rubro_id', rubroId);

    if (error || !prestadores?.length) return [];

    const excluidos = new Set(excluir);
    const prestadorIds = prestadores
      .map((p: any) => p.prestador_id)
      .filter((id: string) => !excluidos.has(id));
    if (!prestadorIds.length) return [];

    const { data: disponibles } = await supabase
      .from('perfiles_prestadores')
      .select('id, ubicacion_base, radio_km')
      .in('id', prestadorIds)
      .eq('disponible', true)
      .eq('esta_verificado', true)
      .or(
        `suscripcion_activa.eq.true,trabajos_gratis_usados.lt.${TRABAJOS_GRATIS_LIMITE}`,
      );

    return (disponibles ?? [])
      .filter((p: any) => {
        const coords = parsePoint(p.ubicacion_base);
        if (!coords) return false;
        const radioEfectivo = ignorarRadioPrestador
          ? radioKm
          : Math.min(radioKm, p.radio_km ?? 10);
        return distanciaKm(lon, lat, coords.lon, coords.lat) <= radioEfectivo;
      })
      .map((p: any) => p.id);
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
