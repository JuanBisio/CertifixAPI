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

// Política de retención de documentos de verificación de identidad (DNI
// frente/dorso, selfie con DNI, matrícula). Distinta de EvidenciasCleanupService:
// acá nunca se borra la fila de perfiles_prestadores (tiene FKs desde
// calificaciones, solicitudes_trabajo, etc.), sólo se nulean las columnas de
// documentos y se borran los objetos de storage correspondientes.
@Injectable()
export class DocumentosVerificacionCleanupService {
  private readonly logger = new Logger(DocumentosVerificacionCleanupService.name);
  private readonly bucket = process.env.DOCUMENTOS_PRESTADORES_BUCKET || 'documentos-prestadores';
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
      .select('id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url')
      .eq('esta_verificado', false)
      .not('verificacion_rechazada_at', 'is', null)
      .lt('verificacion_rechazada_at', rechazoCutoff);

    if (e1) {
      this.logger.error(`Unable to fetch prestadores rechazados: ${e1.message}`);
      return;
    }

    const { data: bajas, error: e2 } = await supabase
      .from('perfiles_prestadores')
      .select('id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url')
      .not('cuenta_baja_at', 'is', null)
      .lt('cuenta_baja_at', bajaCutoff);

    if (e2) {
      this.logger.error(`Unable to fetch prestadores dados de baja: ${e2.message}`);
      return;
    }

    // Dedupe por si un prestador matchea ambas condiciones.
    const targets = new Map<string, PrestadorDocumentos>();
    [...(rechazados ?? []), ...(bajas ?? [])].forEach((row: PrestadorDocumentos) =>
      targets.set(row.id, row),
    );

    if (!targets.size) {
      this.logger.debug('No hay documentos de verificación vencidos para purgar hoy');
      return;
    }

    let limpiados = 0;
    let objetosBorrados = 0;
    let errores = 0;

    for (const row of targets.values()) {
      const paths = this.DOC_COLUMNS.map((col) => this.extractStoragePath(row[col])).filter(
        (p): p is string => !!p,
      );

      if (paths.length) {
        const { error: removeError } = await supabase.storage.from(this.bucket).remove(paths);
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
        this.logger.error(`Update falló para prestador ${row.id}: ${updateError.message}`);
        errores += 1;
        continue;
      }

      limpiados += 1;
    }

    this.logger.log(
      `Cleanup documentos verificación: ${limpiados} prestadores, ${objetosBorrados} objetos borrados, ${errores} errores.`,
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
      const cleaned = path.startsWith(bucketPrefix) ? path.substring(bucketPrefix.length) : path;
      return decodeURIComponent(cleaned);
    } catch {
      this.logger.warn(`Failed to extract storage path from url: ${value}`);
      return null;
    }
  }
}
