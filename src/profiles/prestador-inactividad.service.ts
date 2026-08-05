import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

const INACTIVIDAD_MINUTOS = 60; // minutos sin actividad antes de notificar
const RESPUESTA_PUSH_MINUTOS = 5; // si no responde en 5 min → deshabilitar

@Injectable()
export class PrestadorInactividadService {
  private readonly logger = new Logger(PrestadorInactividadService.name);

  constructor(private supabaseService: SupabaseService) {}

  // Cada 5 minutos: verificar prestadores disponibles sin actividad reciente
  @Cron('*/5 * * * *')
  async checkInactividad() {
    const supabase = this.supabaseService.getServiceClient();
    const ahora = new Date();

    // 1. Deshabilitar prestadores que llevan más de (60 + 5) min sin actividad
    //    (ya se les envió push y no respondieron)
    const limiteDeshabilitacion = new Date(
      ahora.getTime() -
        (INACTIVIDAD_MINUTOS + RESPUESTA_PUSH_MINUTOS) * 60 * 1000,
    ).toISOString();

    const { data: aDesactivar, error: errorDesact } = await supabase
      .from('perfiles_prestadores')
      .update({ disponible: false })
      .eq('disponible', true)
      .lt('ultimo_activo_at', limiteDeshabilitacion)
      .not('ultimo_activo_at', 'is', null)
      .select('id');

    if (errorDesact) {
      this.logger.error(`Error desactivando inactivos: ${errorDesact.message}`);
    } else if (aDesactivar?.length) {
      this.logger.log(
        `${aDesactivar.length} prestadores desactivados por inactividad`,
      );
    }

    // 2. Notificar prestadores que llevan exactamente 60 min sin actividad
    //    (ventana: entre 60 y 65 min sin actividad → push interactiva)
    const limiteNotificacion = new Date(
      ahora.getTime() - INACTIVIDAD_MINUTOS * 60 * 1000,
    ).toISOString();

    const limiteNotificacionMax = new Date(
      ahora.getTime() - (INACTIVIDAD_MINUTOS - 5) * 60 * 1000,
    ).toISOString();

    const { data: aNotificar } = await supabase
      .from('perfiles_prestadores')
      .select('id')
      .eq('disponible', true)
      .lt('ultimo_activo_at', limiteNotificacion)
      .gt('ultimo_activo_at', limiteNotificacionMax)
      .not('ultimo_activo_at', 'is', null);

    if (!aNotificar?.length) return;

    const prestadorIds = aNotificar.map((p: any) => p.id);

    const { data: tokens } = await supabase
      .from('expo_push_tokens')
      .select('expo_push_token')
      .in('user_id', prestadorIds);

    const validTokens = (tokens ?? [])
      .map((t: any) => t.expo_push_token)
      .filter((t: string) => t?.startsWith('ExponentPushToken['));

    if (!validTokens.length) return;

    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          validTokens.map((to: string) => ({
            to,
            title: '¿Seguís disponible?',
            body: 'Hace 1 hora sin actividad. Tocá para seguir recibiendo pedidos o pasá a modo descanso.',
            data: { tipo: 'inactividad_check' },
            // categoryId para botones interactivos configurados en la app
            categoryIdentifier: 'INACTIVIDAD_CHECK',
          })),
        ),
      });
      this.logger.log(
        `Push de inactividad enviado a ${validTokens.length} prestadores`,
      );
    } catch (err: any) {
      this.logger.error(`Error enviando push inactividad: ${err.message}`);
    }
  }
}
