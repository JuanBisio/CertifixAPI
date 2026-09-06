import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreatePrestadorDto } from './dto/create-prestador.dto';
import { UpdateDisponibilidadDto } from './dto/update-disponibilidad.dto';
import { UpdateRcSeguroDto } from './dto/update-rc-seguro.dto';
import { isFileContentAllowed } from '../common/utils/file-signature.util';
import { randomUUID } from 'crypto';

// Exportados para reuso en AccountDeletionCleanupService (borra los mismos
// documentos/foto de storage al purgar una cuenta dada de baja).
export type DocumentoTipo =
  | 'dni_frente'
  | 'dni_dorso'
  | 'selfie_dni'
  | 'matricula'
  | 'foto_perfil'
  | 'rc_poliza';

export const DOCUMENTOS_PRESTADORES_BUCKET =
  process.env.DOCUMENTOS_PRESTADORES_BUCKET || 'documentos-prestadores';
export const FOTOS_PERFIL_BUCKET =
  process.env.FOTOS_PERFIL_BUCKET || 'fotos-perfil';

export const BUCKET_MAP: Record<DocumentoTipo, string> = {
  dni_frente: DOCUMENTOS_PRESTADORES_BUCKET,
  dni_dorso: DOCUMENTOS_PRESTADORES_BUCKET,
  selfie_dni: DOCUMENTOS_PRESTADORES_BUCKET,
  matricula: DOCUMENTOS_PRESTADORES_BUCKET,
  foto_perfil: FOTOS_PERFIL_BUCKET,
  rc_poliza: DOCUMENTOS_PRESTADORES_BUCKET,
};

export const COLUMN_MAP: Record<DocumentoTipo, string> = {
  dni_frente: 'dni_frente_url',
  dni_dorso: 'dni_dorso_url',
  selfie_dni: 'selfie_dni_url',
  matricula: 'matricula_url',
  foto_perfil: 'foto_perfil_url',
  rc_poliza: 'rc_poliza_url',
};

// dni_frente/dni_dorso/selfie_dni/matricula/rc_poliza viven en el bucket
// PRIVADO documentos-prestadores: se guarda el path crudo en la columna y
// las URLs se firman on-demand (server-side, con el service client).
// foto_perfil vive en el bucket público fotos-perfil y sigue usando
// getPublicUrl().
const PRIVATE_DOCUMENT_TYPES = new Set<DocumentoTipo>([
  'dni_frente',
  'dni_dorso',
  'selfie_dni',
  'matricula',
  'rc_poliza',
]);

// El comprobante de póliza de RC puede ser el PDF de la aseguradora, no solo
// una foto — el resto de los documentos de identidad se mantiene JPEG/PNG
// only a propósito (no se relaja esa validación).
const PDF_ALLOWED_TYPES = new Set<DocumentoTipo>(['rc_poliza']);

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);
  // DNI/selfie desde celular con quality 0.8 pesan más que evidencias (cap 3MB).
  private readonly MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
  private readonly ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png']);
  private readonly SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h, igual que evidencias

  constructor(private supabaseService: SupabaseService) {}

  mapPrestadorProfile(prestador: any) {
    if (!prestador) return undefined;
    const { url_certificacion, ...rest } = prestador;
    return {
      ...rest, // ya incluye esta_verificado tal cual viene de la columna real
      // Alias de compatibilidad: GET /profiles/:id siempre devolvió
      // esta_verificado; GET /profiles/me (acá) lo devolvía únicamente como
      // `verificado`, lo que obligaba a la app a saber qué nombre pedir según
      // el endpoint (bug real: ver docs/ROADMAP.md). Se unifica a
      // esta_verificado (el nombre de la columna, ya usado en todo el resto
      // del código); `verificado` queda como alias hasta que la app deje de
      // leerlo — grep `?.verificado` en certifix_mobile antes de sacarlo.
      verificado: rest.esta_verificado,
      certificacion_url: url_certificacion,
    };
  }

  // ─── PERFIL BASE ────────────────────────────────────────────────────────

  async updateProfile(
    profileId: string,
    currentUserId: string,
    dto: UpdateProfileDto,
    accessToken: string,
  ) {
    if (profileId !== currentUserId) {
      throw new ForbiddenException('Solo podés actualizar tu propio perfil');
    }

    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data, error } = await supabase
      .from('perfiles')
      .update(dto)
      .eq('id', profileId)
      .select()
      .single();

    if (error)
      throw new BadRequestException(
        'Error actualizando perfil: ' + error.message,
      );

    return { profile: data };
  }

  async getProfile(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile, error } = await supabase
      .from('perfiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !profile) throw new NotFoundException('Perfil no encontrado');

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('*, prestador_rubros(rubro_id, rubros(id, nombre, icono))')
      .eq('id', userId)
      .single();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    return {
      id: profile.id,
      email: user?.email,
      nombre: profile.nombre,
      telefono: profile.telefono,
      rol: profile.rol,
      strikes_count: profile.strikes_count,
      suspendido: profile.suspendido,
      prestador_profile: this.mapPrestadorProfile(prestador),
    };
  }

  // ─── HISTORIAL DE STRIKES (CAN-02/03/04) ────────────────────────────────

  async getMisStrikes(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile, error } = await supabase
      .from('perfiles')
      .select('strikes_count, suspendido')
      .eq('id', userId)
      .single();

    if (error || !profile) throw new NotFoundException('Perfil no encontrado');

    const { data: historial } = await supabase
      .from('strikes_historial')
      .select('motivo, trabajo_id, created_at')
      .eq('perfil_id', userId)
      .order('created_at', { ascending: false });

    return {
      strikes_count: profile.strikes_count,
      suspendido: profile.suspendido,
      historial: historial ?? [],
    };
  }

  // ─── PERFIL PÚBLICO (para que el cliente vea datos del prestador) ─────────

  async getPublicProfile(prestadorId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // `perfiles` no tiene columna de foto — la del prestador vive en
    // perfiles_prestadores.foto_perfil_url (bug encontrado al implementar
    // RQ-05: esto seleccionaba perfiles.foto_url, columna inexistente, y
    // tiraba abajo el endpoint entero para cualquier llamada).
    const { data: profile, error } = await supabase
      .from('perfiles')
      .select('id, nombre')
      .eq('id', prestadorId)
      .single();

    if (error || !profile) throw new NotFoundException('Perfil no encontrado');

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select(
        'rating, trabajos_completados, tipo_verificacion, esta_verificado, foto_perfil_url, biometric_capture_at, rc_verificado, rc_vencimiento, franjas_horarias, zona_nombre, radio_km, prestador_rubros(rubro_id, rubros(id, nombre, icono))',
      )
      .eq('id', prestadorId)
      .single();

    const { data: calificaciones } = await supabase
      .from('calificaciones')
      .select('puntuacion, comentario, created_at, cliente:cliente_id(nombre)')
      .eq('prestador_id', prestadorId)
      .order('created_at', { ascending: false })
      .limit(10);

    return {
      profile: {
        id: profile.id,
        nombre: profile.nombre,
        // prestador_rubros se deja en el shape crudo del join (mismo que ya
        // esperaba prestador-profile/[id].tsx) — no lo aplanamos acá.
        prestador_rubros: prestador?.prestador_rubros ?? [],
        prestador_profile: {
          rating: prestador?.rating ?? 0,
          trabajos_completados: prestador?.trabajos_completados ?? 0,
          tipo_verificacion: prestador?.tipo_verificacion ?? 'estandar',
          esta_verificado: prestador?.esta_verificado ?? false,
          foto_perfil_url: prestador?.foto_perfil_url ?? null,
          biometric_capture_at: prestador?.biometric_capture_at ?? null,
          rc_verificado: prestador?.rc_verificado ?? false,
          rc_vencimiento: prestador?.rc_vencimiento ?? null,
          franjas_horarias: prestador?.franjas_horarias ?? null,
          zona_nombre: prestador?.zona_nombre ?? null,
          radio_km: prestador?.radio_km ?? null,
        },
        calificaciones: calificaciones ?? [],
      },
    };
  }

  // ─── PRESTADOR: SETUP ────────────────────────────────────────────────────

  async createOrUpdatePrestador(
    userId: string,
    dto: CreatePrestadorDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Validar que todos los rubros existen
    const { data: rubrosDb, error: rubrosError } = await supabase
      .from('rubros')
      .select('id')
      .in('id', dto.rubros_ids);

    if (rubrosError || (rubrosDb ?? []).length !== dto.rubros_ids.length) {
      throw new BadRequestException('Uno o más rubros_ids son inválidos');
    }

    const ubicacionBase = `POINT(${dto.coordenadas.lon} ${dto.coordenadas.lat})`;

    const { data: existente } = await supabase
      .from('perfiles_prestadores')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    const prestadorData: Record<string, any> = {
      id: userId,
      franjas_horarias: dto.franjas_horarias,
      ubicacion_base: ubicacionBase,
    };
    if (!existente) {
      // Alta inicial: estos campos solo se setean acá. Una edición posterior
      // (mismo endpoint) no debe revertir la verificación ni la disponibilidad.
      prestadorData.esta_verificado = false;
      prestadorData.disponible = false;
    }

    // Upsert del perfil de prestador
    const { data: result, error: upsertError } = await supabase
      .from('perfiles_prestadores')
      .upsert(prestadorData, { onConflict: 'id' })
      .select('*')
      .single();

    if (upsertError) {
      this.logger.error(`Upsert prestador falló: ${upsertError.message}`);
      throw new BadRequestException('Error al guardar perfil de prestador');
    }

    // Sincronizar rubros en prestador_rubros
    await supabase.from('prestador_rubros').delete().eq('prestador_id', userId);
    const rubrosInsert = dto.rubros_ids.map((rId) => ({
      prestador_id: userId,
      rubro_id: rId,
    }));
    const { error: rubrosInsertError } = await supabase
      .from('prestador_rubros')
      .insert(rubrosInsert);

    if (rubrosInsertError) {
      this.logger.error(`Error guardando rubros: ${rubrosInsertError.message}`);
      throw new BadRequestException('Error guardando los rubros del prestador');
    }

    // Actualizar rol a prestador
    await supabase
      .from('perfiles')
      .update({ rol: 'prestador' })
      .eq('id', userId);

    this.logger.log(`Perfil de prestador guardado: ${userId}`);
    return { prestador_profile: this.mapPrestadorProfile(result) };
  }

  // ─── PRESTADOR: DISPONIBILIDAD + PING ───────────────────────────────────

  async updateDisponibilidad(
    userId: string,
    dto: UpdateDisponibilidadDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const updateData: Record<string, any> = { disponible: dto.disponible };
    if (dto.disponible) {
      updateData.ultimo_activo_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update(updateData)
      .eq('id', userId)
      .select('*')
      .single();

    if (error || !data)
      throw new BadRequestException('Error actualizando disponibilidad');

    return { prestador_profile: this.mapPrestadorProfile(data) };
  }

  async ping(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    await supabase
      .from('perfiles_prestadores')
      .update({ ultimo_activo_at: new Date().toISOString() })
      .eq('id', userId)
      .eq('disponible', true);

    return { ok: true };
  }

  // ─── PRESTADOR: SEGURO DE RC (beneficio interno, opcional) ──────────────
  // rc_verificado no se toca acá — lo tilda un admin a mano tras revisar el
  // comprobante (ver AdminService.setRcVerificado).

  async updateRcSeguro(
    userId: string,
    dto: UpdateRcSeguroDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const updateData: Record<string, any> = {};
    if (dto.aseguradora !== undefined)
      updateData.rc_aseguradora = dto.aseguradora;
    if (dto.numero_poliza !== undefined)
      updateData.rc_numero_poliza = dto.numero_poliza;
    if (dto.vencimiento !== undefined)
      updateData.rc_vencimiento = dto.vencimiento;

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update(updateData)
      .eq('id', userId)
      .select('*')
      .single();

    if (error)
      throw new BadRequestException(
        'Error guardando datos del seguro de RC: ' + error.message,
      );

    return { prestador_profile: this.mapPrestadorProfile(data) };
  }

  // ─── PRESTADOR: UPLOAD DE DOCUMENTOS ────────────────────────────────────

  async uploadDocumento(
    userId: string,
    tipo: DocumentoTipo,
    file: Express.Multer.File,
    accessToken: string,
  ) {
    if (!file) {
      throw new BadRequestException('El archivo es requerido');
    }
    const allowedMimetypes = PDF_ALLOWED_TYPES.has(tipo)
      ? new Set([...this.ALLOWED_MIMETYPES, 'application/pdf'])
      : this.ALLOWED_MIMETYPES;
    const mimetypeValido = allowedMimetypes.has(file.mimetype);
    if (!mimetypeValido) {
      const formatos = PDF_ALLOWED_TYPES.has(tipo)
        ? 'imágenes JPEG/PNG o PDF'
        : 'imágenes JPEG o PNG';
      throw new BadRequestException(`Solo se permiten ${formatos}`);
    }
    // El Content-Type declarado (file.mimetype) lo elige el cliente y es
    // falseable — se valida además el contenido real vía magic bytes (F6),
    // para que un archivo no-imagen etiquetado como imagen no pase.
    if (!isFileContentAllowed(file.buffer, allowedMimetypes)) {
      throw new BadRequestException(
        'El contenido del archivo no coincide con el tipo declarado',
      );
    }
    if (file.size && file.size > this.MAX_SIZE_BYTES) {
      throw new BadRequestException('El archivo supera el máximo de 5MB');
    }

    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const bucket = BUCKET_MAP[tipo];
    const column = COLUMN_MAP[tipo];
    // fileName usa randomUUID (no el originalname crudo del cliente, ver
    // hallazgo F6 — mismo patrón ya usado en evidencias.service.ts) y ya
    // es único de por sí, nunca colisiona con un objeto existente — upsert:
    // true no hace falta y rompe bajo RLS: Storage necesita poder leer
    // (SELECT) el objeto para decidir insert vs. update, pero estos buckets
    // no le dan SELECT a `authenticated` a propósito (solo signed URLs
    // server-side), así que el upsert siempre fallaba con "new row violates
    // row-level security policy" aun en un path nuevo.
    const extension =
      file.mimetype === 'application/pdf'
        ? 'pdf'
        : file.mimetype === 'image/png'
          ? 'png'
          : 'jpg';
    const fileName = `${userId}/${tipo}_${Date.now()}_${randomUUID()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) {
      this.logger.error(`Upload ${tipo} falló: ${uploadError.message}`);
      throw new BadRequestException(
        `Error subiendo ${tipo}: ${uploadError.message}`,
      );
    }

    let responseUrl: string;
    let storedValue: string;

    if (PRIVATE_DOCUMENT_TYPES.has(tipo)) {
      // Bucket privado: se guarda el path crudo (no hay URL pública) y se
      // firma on-demand con el service client — el cliente autenticado no
      // tiene SELECT sobre este bucket tras la migración de storage.
      storedValue = fileName;
      const signedUrl = await this.getSignedUrlForDocumento(bucket, fileName);
      responseUrl = signedUrl ?? fileName;
    } else {
      const { data: urlData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);
      storedValue = urlData.publicUrl;
      responseUrl = urlData.publicUrl;
    }

    const { error: updateError } = await supabase
      .from('perfiles_prestadores')
      .update({ [column]: storedValue })
      .eq('id', userId);

    if (updateError) {
      this.logger.error(
        `Error guardando URL de ${tipo}: ${updateError.message}`,
      );
      throw new BadRequestException('Error guardando URL del documento');
    }

    // Si se sube matrícula → tipo_verificacion pasa a 'premium' (pendiente revisión admin)
    if (tipo === 'matricula') {
      await supabase
        .from('perfiles_prestadores')
        .update({ tipo_verificacion: 'premium' })
        .eq('id', userId);
    }

    this.logger.log(`Documento ${tipo} subido para usuario ${userId}`);
    return { url: responseUrl, tipo };
  }

  // Mantener retrocompatibilidad con el endpoint /prestador/certificacion
  async uploadCertificacion(
    userId: string,
    file: Express.Multer.File,
    accessToken: string,
  ) {
    return this.uploadDocumento(userId, 'matricula', file, accessToken);
  }

  // ─── PRESTADOR: DOCUMENTOS DE VERIFICACIÓN (uso admin) ──────────────────

  async getSignedUrlForDocumento(
    bucket: string,
    path: string,
    ttlSeconds: number = this.SIGNED_URL_TTL_SECONDS,
  ): Promise<string | null> {
    const service = this.supabaseService.getServiceClient();
    const { data, error } = await service.storage
      .from(bucket)
      .createSignedUrl(path, ttlSeconds);
    if (error) {
      this.logger.warn(
        `No se pudo generar signed URL para ${path}: ${error.message}`,
      );
      return null;
    }
    return data.signedUrl;
  }

  // Filas creadas antes de que uploadDocumento() empezara a guardar el path
  // crudo pueden tener la URL pública completa (flujo viejo con
  // getPublicUrl()) — sin este fallback, createSignedUrl() recibe una URL en
  // vez de un path, falla en silencio, y el admin muestra el documento como
  // "no subido" pese a existir. Mismo criterio que
  // EvidenciasCleanupService/DocumentosVerificacionCleanupService.extractStoragePath.
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

  async getDocumentosPrestador(prestadorId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const { data: prestador, error } = await supabase
      .from('perfiles_prestadores')
      .select(
        'id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url, foto_perfil_url, esta_verificado, tipo_verificacion, verificacion_rechazada_at, cuenta_baja_at, rc_poliza_url, rc_aseguradora, rc_numero_poliza, rc_vencimiento, rc_verificado',
      )
      .eq('id', prestadorId)
      .single();

    if (error || !prestador)
      throw new NotFoundException('Prestador no encontrado');

    const bucket = DOCUMENTOS_PRESTADORES_BUCKET;
    const dniFrentePath = this.extractStoragePath(
      prestador.dni_frente_url,
      bucket,
    );
    const dniDorsoPath = this.extractStoragePath(
      prestador.dni_dorso_url,
      bucket,
    );
    const selfiePath = this.extractStoragePath(
      prestador.selfie_dni_url,
      bucket,
    );
    const matriculaPath = this.extractStoragePath(
      prestador.matricula_url,
      bucket,
    );
    const rcPolizaPath = this.extractStoragePath(
      prestador.rc_poliza_url,
      bucket,
    );

    const [dniFrente, dniDorso, selfie, matricula, rcPoliza] =
      await Promise.all([
        dniFrentePath
          ? this.getSignedUrlForDocumento(bucket, dniFrentePath)
          : Promise.resolve(null),
        dniDorsoPath
          ? this.getSignedUrlForDocumento(bucket, dniDorsoPath)
          : Promise.resolve(null),
        selfiePath
          ? this.getSignedUrlForDocumento(bucket, selfiePath)
          : Promise.resolve(null),
        matriculaPath
          ? this.getSignedUrlForDocumento(bucket, matriculaPath)
          : Promise.resolve(null),
        rcPolizaPath
          ? this.getSignedUrlForDocumento(bucket, rcPolizaPath)
          : Promise.resolve(null),
      ]);

    return {
      prestador_id: prestador.id,
      documentos: {
        dni_frente: { url: dniFrente, subido: !!prestador.dni_frente_url },
        dni_dorso: { url: dniDorso, subido: !!prestador.dni_dorso_url },
        selfie_dni: { url: selfie, subido: !!prestador.selfie_dni_url },
        matricula: { url: matricula, subido: !!prestador.matricula_url },
        rc_poliza: { url: rcPoliza, subido: !!prestador.rc_poliza_url },
      },
      foto_perfil_url: prestador.foto_perfil_url ?? null,
      esta_verificado: prestador.esta_verificado,
      tipo_verificacion: prestador.tipo_verificacion,
      verificacion_rechazada_at: prestador.verificacion_rechazada_at,
      cuenta_baja_at: prestador.cuenta_baja_at,
      rc_aseguradora: prestador.rc_aseguradora ?? null,
      rc_numero_poliza: prestador.rc_numero_poliza ?? null,
      rc_vencimiento: prestador.rc_vencimiento ?? null,
      rc_verificado: prestador.rc_verificado,
      signed_urls_ttl_segundos: this.SIGNED_URL_TTL_SECONDS,
    };
  }
}
