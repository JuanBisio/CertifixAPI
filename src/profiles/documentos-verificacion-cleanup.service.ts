import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

type PrestadorDocumentos = {
  id: string;
  dni_frente_url: string | null;
  dni_dorso_url: string | null;
  selfie_dni_url: string | null;
  matricula_url: string | null;
};

type PrestadorSelfieBiometrica = {
  id: string;
  selfie_dni_url: string | null;
};

// Política de retención de documentos de verificación de identidad (DNI
// frente/dorso, selfie con DNI, matrícula). Distinta de EvidenciasCleanupService:
// acá nunca se borra la fila de perfiles_prestadores (tiene FKs desde
// calificaciones, solicitudes_trabajo, etc.), sólo se nulean las columnas de
// documentos y se borran los objetos de storage correspondientes.
@Injectable()
export class DocumentosVerificacionCleanupService {
  private readonly logger = new Logger(
    DocumentosVerificacionCleanupService.name,
  );
  private readonly bucket =
    process.env.DOCUMENTOS_PRESTADORES_BUCKET || 'documentos-prestadores';
  private readonly RECHAZO_RETENCION_DIAS = 30;
  private readonly BAJA_RETENCION_DIAS = 90;
  private readonly DOC_COLUMNS = [
    'dni_frente_url',
    'dni_dorso_url',
    'selfie_dni_url',
    'matricula_url',
  ] as const;

  constructor(private readonly supabaseService: SupabaseService) {}

  // 5AM: no choca con evidencias (3AM) ni con suscripciones (4AM).
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async purgeDocumentosVerificacionVencidos() {
    const supabase = this.supabaseService.getServiceClient();

    const rechazoCutoff = new Date(
      Date.now() - this.RECHAZO_RETENCION_DIAS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const bajaCutoff = new Date(
      Date.now() - this.BAJA_RETENCION_DIAS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: rechazados, error: e1 } = await supabase
      .from('perfiles_prestadores')
      .select(
        'id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url',
      )
      .eq('esta_verificado', false)
      .not('verificacion_rechazada_at', 'is', null)
      .lt('verificacion_rechazada_at', rechazoCutoff);

    if (e1) {
      this.logger.error(
        `Unable to fetch prestadores rechazados: ${e1.message}`,
      );
      return;
    }

    const { data: bajas, error: e2 } = await supabase
      .from('perfiles_prestadores')
      .select(
        'id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url',
      )
      .not('cuenta_baja_at', 'is', null)
      .lt('cuenta_baja_at', bajaCutoff);

    if (e2) {
      this.logger.error(
        `Unable to fetch prestadores dados de baja: ${e2.message}`,
      );
      return;
    }

    // Dedupe por si un prestador matchea ambas condiciones.
    const targets = new Map<string, PrestadorDocumentos>();
    [...(rechazados ?? []), ...(bajas ?? [])].forEach(
      (row: PrestadorDocumentos) => targets.set(row.id, row),
    );

    if (!targets.size) {
      this.logger.debug(
        'No hay documentos de verificación vencidos para purgar hoy',
      );
      return;
    }

    let limpiados = 0;
    let objetosBorrados = 0;
    let errores = 0;

    for (const row of targets.values()) {
      const paths = this.DOC_COLUMNS.map((col) =>
        this.extractStoragePath(row[col]),
      ).filter((p): p is string => !!p);

      if (paths.length) {
        const { error: removeError } = await supabase.storage
          .from(this.bucket)
          .remove(paths);
        if (removeError) {
          this.logger.error(
            `Storage remove falló para prestador ${row.id}: ${removeError.message}`,
          );
          errores += 1;
          continue;
        }
        objetosBorrados += paths.length;
      }

      const { error: updateError } = await supabase
        .from('perfiles_prestadores')
        .update({
          dni_frente_url: null,
          dni_dorso_url: null,
          selfie_dni_url: null,
          matricula_url: null,
        })
        .eq('id', row.id);

      if (updateError) {
        this.logger.error(
          `Update falló para prestador ${row.id}: ${updateError.message}`,
        );
        errores += 1;
        continue;
      }

      limpiados += 1;
    }

    this.logger.log(
      `Cleanup documentos verificación: ${limpiados} prestadores, ${objetosBorrados} objetos borrados, ${errores} errores.`,
    );
  }

  // Beneficio de seguro de RC: si venció la póliza y nadie la renovó/revisó
  // a mano, rc_verificado cae solo a false. Mismo horario que el resto de
  // esta limpieza — si esta corrida falla, un admin lo repasa a mano
  // (no es bloqueante, es un beneficio informativo, no afecta el matching).
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async purgeRcVencidos() {
    const supabase = this.supabaseService.getServiceClient();
    const hoy = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ rc_verificado: false })
      .eq('rc_verificado', true)
      .lt('rc_vencimiento', hoy)
      .select('id');

    if (error) {
      this.logger.error(
        `Failed to purge rc_verificado vencidos: ${error.message}`,
      );
      return;
    }

    if (data?.length) {
      this.logger.log(
        `rc_verificado dado de baja por vencimiento en ${data.length} prestador(es)`,
      );
    }
  }

  // Política de Privacidad Sección 4.3: la selfie con DNI (dato biométrico)
  // se borra exactamente 48hs después del "resultado del cotejo" —
  // biometric_capture_at, seteado por AdminService al aprobar o rechazar
  // (no al subir la foto). Corre cada hora, a diferencia del resto de esta
  // limpieza (diaria), porque acá el documento promete "exactamente 48hs" y
  // un cron diario dejaría hasta 24hs de margen de más. Sólo toca
  // selfie_dni_url — DNI frente/dorso y matrícula no son datos biométricos,
  // siguen bajo la retención de 30/90 días de purgeDocumentosVerificacionVencidos.
  @Cron(CronExpression.EVERY_HOUR)
  async purgeSelfieBiometrica48h() {
    const supabase = this.supabaseService.getServiceClient();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: vencidas, error } = await supabase
      .from('perfiles_prestadores')
      .select('id, selfie_dni_url')
      .not('biometric_capture_at', 'is', null)
      .not('selfie_dni_url', 'is', null)
      .lt('biometric_capture_at', cutoff);

    if (error) {
      this.logger.error(
        `Unable to fetch selfies biométricas vencidas: ${error.message}`,
      );
      return;
    }

    if (!vencidas?.length) {
      this.logger.debug(
        'No hay selfies biométricas vencidas para purgar esta hora',
      );
      return;
    }

    let limpiadas = 0;
    let errores = 0;

    for (const row of vencidas as PrestadorSelfieBiometrica[]) {
      const path = this.extractStoragePath(row.selfie_dni_url);

      if (path) {
        const { error: removeError } = await supabase.storage
          .from(this.bucket)
          .remove([path]);
        if (removeError) {
          this.logger.error(
            `Storage remove de selfie biométrica falló para prestador ${row.id}: ${removeError.message}`,
          );
          errores += 1;
          continue;
        }
      }

      const { error: updateError } = await supabase
        .from('perfiles_prestadores')
        .update({
          selfie_dni_url: null,
          biometric_deleted_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      if (updateError) {
        this.logger.error(
          `Update de selfie biométrica falló para prestador ${row.id}: ${updateError.message}`,
        );
        errores += 1;
        continue;
      }

      limpiadas += 1;
    }

    this.logger.log(
      `Purga selfie biométrica (48hs): ${limpiadas} prestadores, ${errores} errores.`,
    );
  }

  // Filas creadas antes de este cambio pueden tener la URL pública completa
  // en la columna (flujo viejo con getPublicUrl()), no el path crudo — hay
  // que soportar ambos formatos para no dejarlas sin limpiar nunca. Mismo
  // criterio que EvidenciasCleanupService.extractStoragePath.
  private extractStoragePath(value: string | null): string | null {
    if (!value) return null;
    if (!value.startsWith('http')) return value;

    try {
      const parsed = new URL(value);
      const marker = '/storage/v1/object/public/';
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex === -1) return null;

      const path = parsed.pathname.substring(markerIndex + marker.length);
      const bucketPrefix = `${this.bucket}/`;
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
