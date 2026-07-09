import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateEvidenciaDto } from './dto/create-evidencia.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class EvidenciasService {
  private readonly logger = new Logger(EvidenciasService.name);
  private readonly MAX_SIZE_BYTES = 3 * 1024 * 1024; // 3MB
  private readonly BUCKET = process.env.EVIDENCIAS_BUCKET || 'evidencias';

  constructor(private supabaseService: SupabaseService) {}

  async create(
    userId: string,
    createEvidenciaDto: CreateEvidenciaDto,
    file: Express.Multer.File,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      if (!file) {
        throw new BadRequestException('File is required');
      }

      if (!file.mimetype?.startsWith('image/')) {
        throw new BadRequestException('Solo se permiten imágenes');
      }

      if (file.size && file.size > this.MAX_SIZE_BYTES) {
        throw new BadRequestException('El archivo supera el máximo de 3MB');
      }

      // Verify trabajo exists and user has access
      const { data: trabajo, error: trabajoError } = await supabase
        .from('solicitudes_trabajo')
        .select('cliente_id, prestador_id')
        .eq('id', createEvidenciaDto.trabajo_id)
        .single();

      if (trabajoError || !trabajo) {
        throw new BadRequestException('Work request not found');
      }

      // Verify user is involved in this trabajo
      if (trabajo.cliente_id !== userId && trabajo.prestador_id !== userId) {
        throw new ForbiddenException('Access denied to this work request');
      }

      if (createEvidenciaDto.es_reclamo) {
        const { count } = await supabase
          .from('evidencias')
          .select('id', { count: 'exact', head: true })
          .eq('trabajo_id', createEvidenciaDto.trabajo_id)
          .eq('es_reclamo', true);

        if (typeof count === 'number' && count >= 3) {
          throw new BadRequestException('Máximo 3 fotos por reclamo (3MB c/u).');
        }
      }

      const todayPrefix = new Date().toISOString().slice(0, 10);
      const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
      const storagePath = `evidencias/${todayPrefix}/${createEvidenciaDto.trabajo_id}/${randomUUID()}.${extension}`;
      const expiresAt = createEvidenciaDto.es_reclamo
        ? null
        : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

      // Upload file to Supabase Storage with deterministic path for cleanup
      const { error: uploadError } = await supabase.storage
        .from(this.BUCKET)
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype || 'image/jpeg',
          upsert: false,
        });

      if (uploadError) {
        this.logger.error(`File upload failed: ${uploadError.message}`);
        throw new BadRequestException('File upload failed: ' + uploadError.message);
      }

      // Generar signed URL (válida 1 hora) — funciona tanto con bucket público como privado
      const service = this.supabaseService.getServiceClient();
      const { data: signedData, error: signedError } = await service.storage
        .from(this.BUCKET)
        .createSignedUrl(storagePath, 60 * 60);

      if (signedError) {
        this.logger.warn(`No se pudo generar signed URL: ${signedError.message}`);
      }

      const fileUrl = signedData?.signedUrl ?? storagePath;

      // Guardar el storage path (no la URL) para poder regenerar signed URLs
      const { data, error } = await supabase
        .from('evidencias')
        .insert({
          trabajo_id: createEvidenciaDto.trabajo_id,
          url: storagePath,
          url_archivo: storagePath,
          subido_por: userId,
          es_reclamo: createEvidenciaDto.es_reclamo,
          comentario: createEvidenciaDto.comentario || null,
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
        })
        .select('*')
        .single();

      if (error) {
        this.logger.error(`Failed to create evidencia: ${error.message}`);
        throw new BadRequestException('Failed to save evidence record');
      }

      this.logger.log(`Evidence uploaded for trabajo: ${createEvidenciaDto.trabajo_id}`);
      // Devolver la signed URL en la respuesta inmediata
      return { evidencia: { ...data, url: fileUrl, url_archivo: fileUrl } };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Create evidencia error: ${error.message}`);
      throw new BadRequestException('Failed to upload evidence');
    }
  }

  async findByTrabajo(
    trabajoId: string,
    userId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const nowIso = new Date().toISOString();

    try {
      // Verify user has access to this trabajo
      const { data: trabajo, error: trabajoError } = await supabase
        .from('solicitudes_trabajo')
        .select('cliente_id, prestador_id')
        .eq('id', trabajoId)
        .single();

      if (trabajoError || !trabajo) {
        throw new BadRequestException('Work request not found');
      }

      if (trabajo.cliente_id !== userId && trabajo.prestador_id !== userId) {
        throw new ForbiddenException('Access denied to this work request');
      }

      // Get evidencias
      const { data, error } = await supabase
        .from('evidencias')
        .select('*')
        .eq('trabajo_id', trabajoId)
        .order('created_at', { ascending: true });

      if (error) {
        this.logger.error(`Failed to fetch evidencias: ${error.message}`);
        throw new BadRequestException('Failed to fetch evidence');
      }

      const filtered = (data || []).filter(
        (ev: any) => !ev.expires_at || ev.expires_at > nowIso,
      );

      // Generar signed URLs frescas (1 hora) para cada evidencia
      const service = this.supabaseService.getServiceClient();
      const evidenciasConUrl = await Promise.all(
        filtered.map(async (ev: any) => {
          const path = ev.url_archivo || ev.url;
          if (!path) return ev;
          // Si el campo contiene una URL completa (datos previos al cambio), extraer el path
          const storagePath = path.startsWith('http')
            ? path.split(`/object/public/${this.BUCKET}/`)[1] ?? path.split(`/object/sign/${this.BUCKET}/`)[1]
            : path;
          if (!storagePath) return ev;
          const { data: s } = await service.storage
            .from(this.BUCKET)
            .createSignedUrl(storagePath, 60 * 60);
          const signedUrl = s?.signedUrl ?? path;
          return { ...ev, url: signedUrl, url_archivo: signedUrl };
        }),
      );

      return { evidencias: evidenciasConUrl };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Find evidencias error: ${error.message}`);
      throw new BadRequestException('Failed to fetch evidence');
    }
  }
}
