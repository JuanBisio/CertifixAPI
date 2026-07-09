import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

const REMINDER_WINDOW_DAYS = 3;

@Injectable()
export class SubscriptionsCronService {
  private readonly logger = new Logger(SubscriptionsCronService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  // Todos los días a las 4am: desactivar suscripciones vencidas y avisar próximos vencimientos
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async checkVencimientos() {
    await this.desactivarVencidas();
    await this.recordarProximosVencimientos();
  }

  private async desactivarVencidas() {
    const supabase = this.supabaseService.getServiceClient();
    const nowIso = new Date().toISOString();

    const { data: desactivados, error } = await supabase
      .from('perfiles_prestadores')
      .update({ suscripcion_activa: false, disponible: false })
      .eq('suscripcion_activa', true)
      .lt('suscripcion_vence_at', nowIso)
      .select('id');

    if (error) {
      this.logger.error(`Error desactivando suscripciones vencidas: ${error.message}`);
      return;
    }

    if (desactivados?.length) {
      this.logger.log(`${desactivados.length} suscripciones desactivadas por vencimiento`);
    }
  }

  private async recordarProximosVencimientos() {
    const supabase = this.supabaseService.getServiceClient();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const { data: proximosAVencer, error } = await supabase
      .from('perfiles_prestadores')
      .select('id, suscripcion_vence_at')
      .eq('suscripcion_activa', true)
      .lte('suscripcion_vence_at', windowEnd.toISOString())
      .gt('suscripcion_vence_at', now.toISOString());

    if (error) {
      this.logger.error(`Error buscando vencimientos próximos: ${error.message}`);
      return;
    }

    if (!proximosAVencer?.length) return;

    const prestadorIds = proximosAVencer.map((p: any) => p.id);

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
            title: 'Tu suscripción está por vencer',
            body: 'Renová tu suscripción mensual para seguir recibiendo solicitudes de trabajo.',
            data: { tipo: 'suscripcion_por_vencer' },
          })),
        ),
      });
      this.logger.log(`Recordatorio de vencimiento enviado a ${validTokens.length} prestadores`);
    } catch (err: any) {
      this.logger.error(`Error enviando recordatorio de suscripción: ${err.message}`);
    }
  }
}
