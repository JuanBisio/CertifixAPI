import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

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
    const { data: primeraVez, error: err1 } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id')
      .eq('estado', 'buscando')
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
              timeout_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            })
            .eq('id', solicitud.id);
        } catch (err: any) {
          this.logger.error(`Error en primer timeout solicitud ${solicitud.id}: ${err.message}`);
        }
      }
    }

    // Pasada 2: segundo timeout (24h después de la notificación) → cancelar definitivamente
    const { data: definitivas, error: err2 } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id')
      .eq('estado', 'buscando')
      .lt('timeout_at', now)
      .not('timeout_notificado_at', 'is', null);

    if (err2) {
      this.logger.error(`Error en checkTimeouts (pasada 2): ${err2.message}`);
    } else if (definitivas?.length) {
      this.logger.log(`${definitivas.length} solicitudes a cancelar por timeout definitivo`);
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
          this.logger.log(`Solicitud ${solicitud.id} cancelada por timeout definitivo`);
        } catch (err: any) {
          this.logger.error(`Error cancelando solicitud ${solicitud.id}: ${err.message}`);
        }
      }
    }
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
