import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

type EvidenciaRecord = {
  id: string;
  url_archivo: string;
  trabajo_id: string;
  es_reclamo: boolean;
  expires_at?: string | null;
};

type TrabajoState = {
  id: string;
  estado: string;
};

@Injectable()
export class EvidenciasCleanupService {
  private readonly logger = new Logger(EvidenciasCleanupService.name);
  private readonly bucket = 'evidencias';
  // Estados de disputas.estado que deben bloquear el borrado — no existe un
  // estado de disputa en solicitudes_trabajo.estado (esa columna no lo modela).
  private readonly disputeStates = new Set(['abierta', 'en_revision']);
  private readonly cleanupStates = new Set(['finalizado', 'cerrado']);

  constructor(private readonly supabaseService: SupabaseService) {}

  // Run once per day during the night to free up storage
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredEvidences() {
    const supabase = this.supabaseService.getServiceClient();
    const nowIso = new Date().toISOString();

    const { data: expired, error } = await supabase
      .from('evidencias')
      .select('id, url_archivo, trabajo_id, es_reclamo, expires_at')
      .lt('expires_at', nowIso)
      .eq('es_reclamo', false);

    if (error) {
      this.logger.error(`Unable to fetch expired evidencias: ${error.message}`);
      return;
    }

    if (!expired?.length) {
      this.logger.debug('No expired evidencias to purge today');
      return;
    }

    const trabajoIds = Array.from(new Set(expired.map((e) => e.trabajo_id)));
    const { data: trabajos, error: trabajosError } = await supabase
      .from('solicitudes_trabajo')
      .select('id, estado')
      .in('id', trabajoIds);

    if (trabajosError) {
      this.logger.error(`Unable to fetch trabajos for cleanup: ${trabajosError.message}`);
      return;
    }

    const trabajoEstadoMap = new Map<string, string>();

    (trabajos || []).forEach((t: TrabajoState | null) => {
      if (t?.id) {
        trabajoEstadoMap.set(t.id, String(t.estado || '').toLowerCase());
      }
    });

    // El estado de disputa vive en disputas.estado, no en solicitudes_trabajo.estado
    // (esa columna nunca tuvo esos valores) — hay que consultar la tabla real.
    const { data: disputasAbiertas, error: disputasError } = await supabase
      .from('disputas')
      .select('trabajo_id, estado')
      .in('trabajo_id', trabajoIds);

    if (disputasError) {
      this.logger.error(`Unable to fetch disputas for cleanup: ${disputasError.message}`);
      return;
    }

    const blockedTrabajoIds = new Set(
      (disputasAbiertas || [])
        .filter((d) => d?.estado && this.disputeStates.has(String(d.estado).toLowerCase()))
        .map((d) => d.trabajo_id),
    );

    let deleted = 0;
    let skipped = 0;

    for (const evidencia of expired as EvidenciaRecord[]) {
      const estado = trabajoEstadoMap.get(evidencia.trabajo_id);

      if (blockedTrabajoIds.has(evidencia.trabajo_id)) {
        skipped += 1;
        continue;
      }

      if (!estado || !this.cleanupStates.has(estado)) {
        skipped += 1;
        continue;
      }

      const storagePath = this.extractStoragePath(evidencia.url_archivo);

      if (!storagePath) {
        this.logger.warn(`Could not derive storage path for evidencia ${evidencia.id}`);
        continue;
      }

      const { error: storageError } = await supabase.storage
        .from(this.bucket)
        .remove([storagePath]);

      if (storageError) {
        this.logger.error(
          `Failed deleting storage object for evidencia ${evidencia.id}: ${storageError.message}`,
        );
        continue;
      }

      const { error: deleteError } = await supabase
        .from('evidencias')
        .delete()
        .eq('id', evidencia.id);

      if (deleteError) {
        this.logger.error(`Failed deleting evidencia row ${evidencia.id}: ${deleteError.message}`);
        continue;
      }

      deleted += 1;
    }

    this.logger.log(
      `Evidencias cleanup finished. Deleted: ${deleted}. Skipped (disputa/reclamo): ${skipped}.`,
    );
  }

  // Desde que el bucket pasó a privado, `url_archivo` guarda el path crudo del
  // storage (ver evidencias.service.ts), no una URL completa. Se mantiene el
  // parseo de URL como fallback para filas viejas creadas cuando el bucket
  // todavía era público, con el mismo criterio que getEvidencias().
  private extractStoragePath(url: string): string | null {
    if (!url.startsWith('http')) {
      return url;
    }

    try {
      const parsed = new URL(url);
      const marker = '/storage/v1/object/public/';
      const markerIndex = parsed.pathname.indexOf(marker);

      if (markerIndex === -1) return null;

      const path = parsed.pathname.substring(markerIndex + marker.length);
      const bucketPrefix = `${this.bucket}/`;

      const cleaned = path.startsWith(bucketPrefix) ? path.substring(bucketPrefix.length) : path;
      return decodeURIComponent(cleaned);
    } catch (err) {
      this.logger.warn(`Failed to extract storage path from url: ${url}`);
      return null;
    }
  }
}
