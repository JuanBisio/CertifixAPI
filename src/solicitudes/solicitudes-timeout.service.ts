import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MAX_CANDIDATOS_PROGRAMADO } from './solicitudes.service';
import {
  ULTIMA_RONDA,
  construirPayloadRonda,
  esRondaDeRescate,
  minutosHastaProximaRonda,
  radioDeRonda,
} from './matching-rondas';
import { parsePoint } from '../common/utils/geo.util';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Fila de `solicitudes_trabajo` tal como la lee el motor de rondas. */
interface SolicitudPendiente {
  id: string;
  rubro_id: string;
  urgencia: string;
  descripcion: string | null;
  franjas_horarias: string[] | null;
  candidatos_count: number | null;
  postulacion_deadline_at: string | null;
  ronda_matching: number | null;
  ronda_matching_at: string | null;
  created_at: string;
  // El embed llega como objeto o como array de uno según la cardinalidad que
  // infiera PostgREST para la FK.
  ubicacion_privada?:
    | { ubicacion_real: string | null }
    | Array<{ ubicacion_real: string | null }>
    | null;
}

@Injectable()
export class SolicitudesTimeoutService {
  private readonly logger = new Logger(SolicitudesTimeoutService.name);

  constructor(
    private supabaseService: SupabaseService,
    private notificationsService: NotificationsService,
  ) {}

  // Cada 2 minutos: gestiona timeouts de solicitudes sin aceptar
  @Cron('*/2 * * * *')
  async checkTimeouts() {
    const supabase = this.supabaseService.getServiceClient();
    const now = new Date().toISOString();

    // Pasada 1: primer timeout (10 min) → notificar al cliente y dar 24h más
    // (solo modo urgente: 'programado' usa postulacion_deadline_at, no timeout_at)
    const { data: primeraVez, error: err1 } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id')
      .eq('estado', 'buscando')
      .eq('urgencia', 'ahora')
      .lt('timeout_at', now)
      .is('timeout_notificado_at', null);

    if (err1) {
      this.logger.error(`Error en checkTimeouts (pasada 1): ${err1.message}`);
    } else if (primeraVez?.length) {
      this.logger.log(`${primeraVez.length} solicitudes con primer timeout`);
      for (const solicitud of primeraVez) {
        try {
          await this.notificarCliente(
            supabase,
            solicitud.cliente_id,
            solicitud.id,
            'Seguimos buscando tu técnico',
            'Aún no encontramos un técnico disponible. Te avisamos en cuanto uno acepte.',
          );
          await supabase
            .from('solicitudes_trabajo')
            .update({
              timeout_notificado_at: now,
              timeout_at: new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ).toISOString(),
            })
            .eq('id', solicitud.id);
        } catch (err: any) {
          this.logger.error(
            `Error en primer timeout solicitud ${solicitud.id}: ${err.message}`,
          );
        }
      }
    }

    // Pasada 2: segundo timeout (24h después de la notificación) → cancelar definitivamente
    const { data: definitivas, error: err2 } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id')
      .eq('estado', 'buscando')
      .eq('urgencia', 'ahora')
      .lt('timeout_at', now)
      .not('timeout_notificado_at', 'is', null);

    if (err2) {
      this.logger.error(`Error en checkTimeouts (pasada 2): ${err2.message}`);
    } else if (definitivas?.length) {
      this.logger.log(
        `${definitivas.length} solicitudes a cancelar por timeout definitivo`,
      );
      for (const solicitud of definitivas) {
        try {
          const { data: cancelada } = await supabase
            .from('solicitudes_trabajo')
            .update({ estado: 'cancelado' })
            .eq('id', solicitud.id)
            .eq('estado', 'buscando')
            .select('id')
            .single();

          if (!cancelada) continue;

          await this.notificarCliente(
            supabase,
            solicitud.cliente_id,
            solicitud.id,
            'Solicitud cancelada',
            'No encontramos un técnico disponible en este momento. Podés crear una nueva solicitud.',
          );
          this.logger.log(
            `Solicitud ${solicitud.id} cancelada por timeout definitivo`,
          );
        } catch (err: any) {
          this.logger.error(
            `Error cancelando solicitud ${solicitud.id}: ${err.message}`,
          );
        }
      }
    }

    // Pasada 3: PROGRAMADO sin ningún candidato tras vencer el plazo de postulación → cancelar.
    // Si ya hay 1-2 candidatos no se cancela: el cliente puede elegir cuando quiera,
    // postularse_a_solicitud ya rechaza nuevas postulaciones pasado el deadline.
    const { data: sinCandidatos, error: err3 } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id')
      .eq('estado', 'buscando')
      .eq('urgencia', 'programado')
      .eq('candidatos_count', 0)
      .lt('postulacion_deadline_at', now);

    if (err3) {
      this.logger.error(`Error en checkTimeouts (pasada 3): ${err3.message}`);
    } else if (sinCandidatos?.length) {
      this.logger.log(
        `${sinCandidatos.length} solicitudes programadas a cancelar sin candidatos`,
      );
      for (const solicitud of sinCandidatos) {
        try {
          const { data: cancelada } = await supabase
            .from('solicitudes_trabajo')
            .update({ estado: 'cancelado' })
            .eq('id', solicitud.id)
            .eq('estado', 'buscando')
            .eq('candidatos_count', 0)
            .select('id')
            .single();

          if (!cancelada) continue;

          await this.notificarCliente(
            supabase,
            solicitud.cliente_id,
            solicitud.id,
            'Solicitud cancelada',
            'Ningún técnico se postuló a tiempo. Podés crear una nueva solicitud.',
          );
          this.logger.log(
            `Solicitud ${solicitud.id} cancelada por falta de postulaciones`,
          );
        } catch (err: any) {
          this.logger.error(
            `Error cancelando solicitud programada ${solicitud.id}: ${err.message}`,
          );
        }
      }
    }
  }

  // ─── SOL-04: motor de rondas del radio de matching adaptativo ─────────────
  //
  // Cada solicitud `buscando` arranca en la ronda 1 (10 km, disparada por
  // SolicitudesService.create()) y va ampliando el radio — 20, 40, 80 km —
  // hasta que alguien la toma o se agota la escalera. El estado vive en la
  // fila (`ronda_matching`/`ronda_matching_at`), no en memoria: un restart del
  // proceso no pierde ninguna ronda pendiente.
  @Cron('*/2 * * * *')
  async avanzarRondasDeMatching() {
    const supabase = this.supabaseService.getServiceClient();
    const ahora = Date.now();

    const { data: pendientes, error } = await supabase
      .from('solicitudes_trabajo')
      .select(
        'id, rubro_id, urgencia, descripcion, estado, franjas_horarias, ' +
          'candidatos_count, postulacion_deadline_at, ronda_matching, ' +
          'ronda_matching_at, created_at, ' +
          'ubicacion_privada:solicitudes_ubicacion_privada(ubicacion_real)',
      )
      .eq('estado', 'buscando')
      .is('prestador_id', null)
      .lt('ronda_matching', ULTIMA_RONDA);

    if (error) {
      this.logger.error(
        `Error buscando solicitudes para avanzar de ronda: ${error.message} ` +
          `(code=${(error as any).code ?? '?'}, details=${(error as any).details ?? '?'}, ` +
          `hint=${(error as any).hint ?? '?'})`,
      );
      return;
    }
    if (!pendientes?.length) return;

    // Cast: el embed de solicitudes_ubicacion_privada no está en los tipos
    // generados de Supabase, así que supabase-js lo infiere como error.
    for (const solicitud of pendientes as unknown as SolicitudPendiente[]) {
      try {
        await this.avanzarRonda(supabase, solicitud, ahora);
      } catch (err: any) {
        this.logger.error(
          `Error avanzando la ronda de matching de ${solicitud.id}: ${err.message}`,
        );
      }
    }
  }

  private async avanzarRonda(
    supabase: SupabaseClient,
    solicitud: SolicitudPendiente,
    ahora: number,
  ) {
    const rondaActual: number = solicitud.ronda_matching ?? 1;
    if (rondaActual >= ULTIMA_RONDA) return;

    // Programado: sin sentido ampliar si ya se llenó el cupo de candidatos o
    // si venció el plazo (postularse_a_solicitud rechaza igual pasado el
    // deadline — mandar el push sería mandar a la gente contra una pared).
    if (solicitud.urgencia === 'programado') {
      if ((solicitud.candidatos_count ?? 0) >= MAX_CANDIDATOS_PROGRAMADO)
        return;
      if (
        solicitud.postulacion_deadline_at &&
        new Date(solicitud.postulacion_deadline_at).getTime() <= ahora
      )
        return;
    }

    // Cuánto esperar antes de ampliar depende de si la ronda actual encontró
    // a alguien: si notificó a ≥1 prestador se le da tiempo a responder; si
    // quedó vacía no tiene sentido esperar (decisión de producto, ver
    // matching-rondas.ts).
    const { count, error: errCount } = await supabase
      .from('solicitud_notificaciones')
      .select('id', { count: 'exact', head: true })
      .eq('solicitud_id', solicitud.id)
      .eq('ronda', rondaActual);

    if (errCount) {
      this.logger.error(
        `Error contando notificados de ${solicitud.id} (ronda ${rondaActual}): ` +
          `${errCount.message} (code=${errCount.code ?? '?'}, ` +
          `details=${errCount.details ?? '?'}, hint=${errCount.hint ?? '?'})`,
      );
      return;
    }

    const notificados = count ?? 0;
    const esperaMin = minutosHastaProximaRonda(solicitud.urgencia, notificados);
    const desde = new Date(
      solicitud.ronda_matching_at ?? solicitud.created_at,
    ).getTime();
    if (ahora - desde < esperaMin * 60 * 1000) return;

    const proximaRonda = rondaActual + 1;

    // CAS sobre la ronda: si otro tick (u otra instancia del backend) ya la
    // avanzó, esta pasada no hace nada. Mismo espíritu que el
    // `UPDATE ... WHERE estado='buscando'` de accept().
    const { data: avanzada } = await supabase
      .from('solicitudes_trabajo')
      .update({
        ronda_matching: proximaRonda,
        ronda_matching_at: new Date(ahora).toISOString(),
      })
      .eq('id', solicitud.id)
      .eq('ronda_matching', rondaActual)
      .eq('estado', 'buscando')
      .select('id')
      .single();

    if (!avanzada) return;

    const ubicacion = Array.isArray(solicitud.ubicacion_privada)
      ? solicitud.ubicacion_privada[0]
      : solicitud.ubicacion_privada;
    const coords = parsePoint(ubicacion?.ubicacion_real);
    if (!coords) {
      this.logger.error(
        `Solicitud ${solicitud.id} sin ubicacion_real parseable: no se puede ` +
          `notificar la ronda ${proximaRonda}`,
      );
      return;
    }

    const esProgramado = solicitud.urgencia === 'programado';

    const nuevos =
      await this.notificationsService.notifyPrestadoresParaSolicitud({
        solicitudId: solicitud.id,
        rubroId: solicitud.rubro_id,
        lon: coords.lon,
        lat: coords.lat,
        payload: construirPayloadRonda({
          esProgramado,
          descripcion: solicitud.descripcion ?? '',
          solicitudId: solicitud.id,
          rubroId: solicitud.rubro_id,
          estado: 'buscando',
          ronda: proximaRonda,
        }),
        franjasHorarias: esProgramado ? solicitud.franjas_horarias : null,
        ronda: proximaRonda,
        radioKm: radioDeRonda(proximaRonda),
        ignorarRadioPrestador: esRondaDeRescate(proximaRonda),
      });

    this.logger.log(
      `Solicitud ${solicitud.id}: ronda ${rondaActual} → ${proximaRonda} ` +
        `(${radioDeRonda(proximaRonda)} km), ${nuevos} prestadores nuevos notificados`,
    );
  }

  private async notificarCliente(
    supabase: any,
    clienteId: string,
    solicitudId: string,
    title: string,
    body: string,
  ) {
    const { data: tokens } = await supabase
      .from('expo_push_tokens')
      .select('expo_push_token')
      .eq('user_id', clienteId);

    const validTokens = (tokens ?? [])
      .map((t: any) => t.expo_push_token)
      .filter((t: string) => t?.startsWith('ExponentPushToken['));

    if (!validTokens.length) return;

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        validTokens.map((to: string) => ({
          to,
          title,
          body,
          data: { solicitudId, estado: 'buscando' },
        })),
      ),
    });
  }
}
