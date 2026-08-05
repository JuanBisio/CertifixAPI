import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { BUCKET_MAP, COLUMN_MAP, DocumentoTipo } from './profiles.service';

const DOCUMENT_TYPES: DocumentoTipo[] = [
  'dni_frente',
  'dni_dorso',
  'selfie_dni',
  'matricula',
  'foto_perfil',
  'rc_poliza',
];

type PerfilPendienteEliminacion = {
  id: string;
};

// Cumplimiento de privacidad V1 (T&C Sección 2.6 / Política Sección 14.2):
// supresión real de datos identificables 30 días después de que el usuario
// solicitó la baja (AuthService.requestAccountDeletion). No se borra la
// fila de perfiles — calificaciones/calificaciones_cliente/solicitudes_trabajo
// la referencian sin ON DELETE CASCADE (confirmado contra el schema real),
// así que se anonimiza in-place, lo que disocia identidad automáticamente
// en cualquier reseña que la referencie sin romper esas FKs. Tampoco se
// tocan suscripcion_pagos/payments: es el registro contable/fiscal a
// retener (Política Sección 9), no datos identificables de contacto.
@Injectable()
export class AccountDeletionCleanupService {
  private readonly logger = new Logger(AccountDeletionCleanupService.name);
  private readonly RETENCION_DIAS = 30;

  constructor(private readonly supabaseService: SupabaseService) {}

  // 6AM: sigue la convención horaria existente (evidencias 3AM, suscripciones
  // 4AM, documentos de verificación 5AM).
  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async purgeCuentasEliminadas() {
    const supabase = this.supabaseService.getServiceClient();
    const cutoff = new Date(
      Date.now() - this.RETENCION_DIAS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: pendientes, error } = await supabase
      .from('perfiles')
      .select('id')
      .not('eliminacion_solicitada_at', 'is', null)
      .is('eliminado_at', null)
      .lt('eliminacion_solicitada_at', cutoff);

    if (error) {
      this.logger.error(
        `Unable to fetch cuentas pendientes de eliminación: ${error.message}`,
      );
      return;
    }

    if (!pendientes?.length) {
      this.logger.debug(
        'No hay cuentas pendientes de eliminación para purgar hoy',
      );
      return;
    }

    let purgadas = 0;
    let errores = 0;

    for (const perfil of pendientes as PerfilPendienteEliminacion[]) {
      try {
        await this.purgeUnaCuenta(supabase, perfil.id);
        purgadas += 1;
      } catch (err: any) {
        // Query por condición (no cola): una cuenta que falla acá vuelve a
        // aparecer en la corrida de mañana, porque eliminado_at sigue null.
        this.logger.error(`Purga de cuenta ${perfil.id} falló: ${err.message}`);
        errores += 1;
      }
    }

    this.logger.log(
      `Purga de cuentas eliminadas: ${purgadas} procesadas, ${errores} errores.`,
    );
  }

  private async purgeUnaCuenta(supabase: any, userId: string) {
    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select(Object.values(COLUMN_MAP).join(', '))
      .eq('id', userId)
      .maybeSingle();

    if (prestador) {
      await this.purgeDocumentosPrestador(supabase, userId, prestador);
    }

    const { error: perfilError } = await supabase
      .from('perfiles')
      .update({
        nombre: 'Usuario eliminado',
        telefono: null,
        eliminado_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (perfilError) {
      throw new Error(`No se pudo anonimizar perfiles: ${perfilError.message}`);
    }

    const { error: authError } = await supabase.auth.admin.deleteUser(userId);
    if (authError) {
      // No bloqueante: la anonimización ya se aplicó, esto solo saca el
      // usuario de auth.users (email/login). Se loguea para repasar a mano.
      this.logger.warn(
        `No se pudo borrar el usuario de Auth ${userId}: ${authError.message}`,
      );
    }
  }

  private async purgeDocumentosPrestador(
    supabase: any,
    userId: string,
    prestador: Record<string, any>,
  ) {
    const pathsPorBucket = new Map<string, string[]>();

    for (const tipo of DOCUMENT_TYPES) {
      const column = COLUMN_MAP[tipo];
      const bucket = BUCKET_MAP[tipo];
      const path = this.extractStoragePath(prestador[column], bucket);
      if (!path) continue;

      const paths = pathsPorBucket.get(bucket) ?? [];
      paths.push(path);
      pathsPorBucket.set(bucket, paths);
    }

    for (const [bucket, paths] of pathsPorBucket) {
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) {
        this.logger.error(
          `Storage remove falló (${bucket}) para prestador ${userId}: ${error.message}`,
        );
      }
    }

    const nullColumns = Object.fromEntries(
      DOCUMENT_TYPES.map((tipo) => [COLUMN_MAP[tipo], null]),
    );

    const { error: updateError } = await supabase
      .from('perfiles_prestadores')
      .update({
        ...nullColumns,
        bio: null,
        zona_nombre: null,
        ubicacion_base: null,
        disponible: false,
        esta_verificado: false,
        suscripcion_activa: false,
        cuenta_baja_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (updateError) {
      throw new Error(
        `No se pudo anonimizar perfiles_prestadores: ${updateError.message}`,
      );
    }
  }

  // Mismo criterio que en los otros cleanup services: dni_frente/dni_dorso/
  // selfie_dni/matricula/rc_poliza guardan el path crudo (bucket privado),
  // foto_perfil guarda la URL pública completa — hay que soportar ambos.
  private extractStoragePath(
    value: string | null,
    bucket: string,
  ): string | null {
    if (!value) return null;
    if (!value.startsWith('http')) return value;

    try {
      const parsed = new URL(value);
      const marker = '/storage/v1/object/public/';
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex === -1) return null;

      const path = parsed.pathname.substring(markerIndex + marker.length);
      const bucketPrefix = `${bucket}/`;
      const cleaned = path.startsWith(bucketPrefix)
        ? path.substring(bucketPrefix.length)
        : path;
      return decodeURIComponent(cleaned);
    } catch {
      this.logger.warn(`Failed to extract storage path from url: ${value}`);
      return null;
    }
  }
}
