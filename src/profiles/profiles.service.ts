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

type DocumentoTipo = 'dni_frente' | 'dni_dorso' | 'selfie_dni' | 'matricula' | 'foto_perfil';

const DOCUMENTOS_PRESTADORES_BUCKET =
  process.env.DOCUMENTOS_PRESTADORES_BUCKET || 'documentos-prestadores';
const FOTOS_PERFIL_BUCKET = process.env.FOTOS_PERFIL_BUCKET || 'fotos-perfil';

const BUCKET_MAP: Record<DocumentoTipo, string> = {
  dni_frente: DOCUMENTOS_PRESTADORES_BUCKET,
  dni_dorso: DOCUMENTOS_PRESTADORES_BUCKET,
  selfie_dni: DOCUMENTOS_PRESTADORES_BUCKET,
  matricula: DOCUMENTOS_PRESTADORES_BUCKET,
  foto_perfil: FOTOS_PERFIL_BUCKET,
};

const COLUMN_MAP: Record<DocumentoTipo, string> = {
  dni_frente: 'dni_frente_url',
  dni_dorso: 'dni_dorso_url',
  selfie_dni: 'selfie_dni_url',
  matricula: 'matricula_url',
  foto_perfil: 'foto_perfil_url',
};

// dni_frente/dni_dorso/selfie_dni/matricula viven en el bucket PRIVADO
// documentos-prestadores: se guarda el path crudo en la columna y las URLs
// se firman on-demand (server-side, con el service client). foto_perfil
// vive en el bucket público fotos-perfil y sigue usando getPublicUrl().
const PRIVATE_DOCUMENT_TYPES = new Set<DocumentoTipo>([
  'dni_frente',
  'dni_dorso',
  'selfie_dni',
  'matricula',
]);

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
    const { esta_verificado, url_certificacion, ...rest } = prestador;
    return { ...rest, verificado: esta_verificado, certificacion_url: url_certificacion };
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

    if (error) throw new BadRequestException('Error actualizando perfil: ' + error.message);

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

    const { data: { user } } = await supabase.auth.getUser();

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
        'rating, trabajos_completados, tipo_verificacion, esta_verificado, foto_perfil_url, prestador_rubros(rubro_id, rubros(id, nombre, icono))',
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
        },
        calificaciones: calificaciones ?? [],
      },
    };
  }

  // ─── PRESTADOR: SETUP ────────────────────────────────────────────────────

  async createOrUpdatePrestador(userId: string, dto: CreatePrestadorDto, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Validar que todos los rubros existen
    const { data: rubrosDb, error: rubrosError } = await supabase
      .from('rubros')
      .select('id')
      .in('id', dto.rubros_ids);

    if (rubrosError || (rubrosDb ?? []).length !== dto.rubros_ids.length) {
      throw new BadRequestException('Uno o más rubros_ids son inválidos');
    }

    const ubicacionBase = dto.coordenadas
      ? `POINT(${dto.coordenadas.lon} ${dto.coordenadas.lat})`
      : undefined;

    const { data: existente } = await supabase
      .from('perfiles_prestadores')
      .select('id')
      .eq('id', userId)
      .maybeSingle();

    const prestadorData: Record<string, any> = {
      id: userId,
      franjas_horarias: dto.franjas_horarias,
    };
    if (ubicacionBase) prestadorData.ubicacion_base = ubicacionBase;
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
    await supabase.from('perfiles').update({ rol: 'prestador' }).eq('id', userId);

    this.logger.log(`Perfil de prestador guardado: ${userId}`);
    return { prestador_profile: this.mapPrestadorProfile(result) };
  }

  // ─── PRESTADOR: DISPONIBILIDAD + PING ───────────────────────────────────

  async updateDisponibilidad(userId: string, dto: UpdateDisponibilidadDto, accessToken: string) {
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

    if (error || !data) throw new BadRequestException('Error actualizando disponibilidad');

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
    if (!this.ALLOWED_MIMETYPES.has(file.mimetype)) {
      throw new BadRequestException('Solo se permiten imágenes JPEG o PNG');
    }
    if (file.size && file.size > this.MAX_SIZE_BYTES) {
      throw new BadRequestException('El archivo supera el máximo de 5MB');
    }

    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const bucket = BUCKET_MAP[tipo];
    const column = COLUMN_MAP[tipo];
    // fileName ya incluye Date.now(), nunca colisiona con un objeto existente
    // — upsert:true no hace falta y rompe bajo RLS: Storage necesita poder
    // leer (SELECT) el objeto para decidir insert vs. update, pero estos
    // buckets no le dan SELECT a `authenticated` a propósito (solo signed
    // URLs server-side), así que el upsert siempre fallaba con
    // "new row violates row-level security policy" aun en un path nuevo.
    const fileName = `${userId}/${tipo}_${Date.now()}_${file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file.buffer, { contentType: file.mimetype });

    if (uploadError) {
      this.logger.error(`Upload ${tipo} falló: ${uploadError.message}`);
      throw new BadRequestException(`Error subiendo ${tipo}: ${uploadError.message}`);
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
      const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName);
      storedValue = urlData.publicUrl;
      responseUrl = urlData.publicUrl;
    }

    const { error: updateError } = await supabase
      .from('perfiles_prestadores')
      .update({ [column]: storedValue })
      .eq('id', userId);

    if (updateError) {
      this.logger.error(`Error guardando URL de ${tipo}: ${updateError.message}`);
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
  async uploadCertificacion(userId: string, file: Express.Multer.File, accessToken: string) {
    return this.uploadDocumento(userId, 'matricula', file, accessToken);
  }

  // ─── PRESTADOR: DOCUMENTOS DE VERIFICACIÓN (uso admin) ──────────────────

  async getSignedUrlForDocumento(
    bucket: string,
    path: string,
    ttlSeconds: number = this.SIGNED_URL_TTL_SECONDS,
  ): Promise<string | null> {
    const service = this.supabaseService.getServiceClient();
    const { data, error } = await service.storage.from(bucket).createSignedUrl(path, ttlSeconds);
    if (error) {
      this.logger.warn(`No se pudo generar signed URL para ${path}: ${error.message}`);
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
  private extractStoragePath(value: string | null, bucket: string): string | null {
    if (!value) return null;
    if (!value.startsWith('http')) return value;

    try {
      const parsed = new URL(value);
      const marker = '/storage/v1/object/public/';
      const markerIndex = parsed.pathname.indexOf(marker);
      if (markerIndex === -1) return null;

      const path = parsed.pathname.substring(markerIndex + marker.length);
      const bucketPrefix = `${bucket}/`;
      const cleaned = path.startsWith(bucketPrefix) ? path.substring(bucketPrefix.length) : path;
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
        'id, dni_frente_url, dni_dorso_url, selfie_dni_url, matricula_url, foto_perfil_url, esta_verificado, tipo_verificacion, verificacion_rechazada_at, cuenta_baja_at',
      )
      .eq('id', prestadorId)
      .single();

    if (error || !prestador) throw new NotFoundException('Prestador no encontrado');

    const bucket = DOCUMENTOS_PRESTADORES_BUCKET;
    const dniFrentePath = this.extractStoragePath(prestador.dni_frente_url, bucket);
    const dniDorsoPath = this.extractStoragePath(prestador.dni_dorso_url, bucket);
    const selfiePath = this.extractStoragePath(prestador.selfie_dni_url, bucket);
    const matriculaPath = this.extractStoragePath(prestador.matricula_url, bucket);

    const [dniFrente, dniDorso, selfie, matricula] = await Promise.all([
      dniFrentePath ? this.getSignedUrlForDocumento(bucket, dniFrentePath) : Promise.resolve(null),
      dniDorsoPath ? this.getSignedUrlForDocumento(bucket, dniDorsoPath) : Promise.resolve(null),
      selfiePath ? this.getSignedUrlForDocumento(bucket, selfiePath) : Promise.resolve(null),
      matriculaPath ? this.getSignedUrlForDocumento(bucket, matriculaPath) : Promise.resolve(null),
    ]);

    return {
      prestador_id: prestador.id,
      documentos: {
        dni_frente: { url: dniFrente, subido: !!prestador.dni_frente_url },
        dni_dorso: { url: dniDorso, subido: !!prestador.dni_dorso_url },
        selfie_dni: { url: selfie, subido: !!prestador.selfie_dni_url },
        matricula: { url: matricula, subido: !!prestador.matricula_url },
      },
      foto_perfil_url: prestador.foto_perfil_url ?? null,
      esta_verificado: prestador.esta_verificado,
      tipo_verificacion: prestador.tipo_verificacion,
      verificacion_rechazada_at: prestador.verificacion_rechazada_at,
      cuenta_baja_at: prestador.cuenta_baja_at,
      signed_urls_ttl_segundos: this.SIGNED_URL_TTL_SECONDS,
    };
  }
}
