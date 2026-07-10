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

const BUCKET_MAP: Record<DocumentoTipo, string> = {
  dni_frente: 'documentos-prestadores',
  dni_dorso: 'documentos-prestadores',
  selfie_dni: 'documentos-prestadores',
  matricula: 'documentos-prestadores',
  foto_perfil: 'fotos-perfil',
};

const COLUMN_MAP: Record<DocumentoTipo, string> = {
  dni_frente: 'dni_frente_url',
  dni_dorso: 'dni_dorso_url',
  selfie_dni: 'selfie_dni_url',
  matricula: 'matricula_url',
  foto_perfil: 'foto_perfil_url',
};

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

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
      prestador_profile: this.mapPrestadorProfile(prestador),
    };
  }

  // ─── PERFIL PÚBLICO (para que el cliente vea datos del prestador) ─────────

  async getPublicProfile(prestadorId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile, error } = await supabase
      .from('perfiles')
      .select('id, nombre, foto_url')
      .eq('id', prestadorId)
      .single();

    if (error || !profile) throw new NotFoundException('Perfil no encontrado');

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select(
        'rating, trabajos_completados, radio_km, tipo_verificacion, esta_verificado, zona_nombre, prestador_rubros(rubro_id, rubros(id, nombre, icono))',
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
        foto_url: profile.foto_url ?? null,
        rating: prestador?.rating ?? 0,
        trabajos_completados: prestador?.trabajos_completados ?? 0,
        radio_km: prestador?.radio_km ?? null,
        tipo_verificacion: prestador?.tipo_verificacion ?? 'estandar',
        esta_verificado: prestador?.esta_verificado ?? false,
        zona_nombre: prestador?.zona_nombre ?? null,
        rubros: (prestador?.prestador_rubros ?? []).map((pr: any) => pr.rubros).filter(Boolean),
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

    const prestadorData: Record<string, any> = {
      id: userId,
      radio_km: dto.radio_km,
      franjas_horarias: dto.franjas_horarias,
      esta_verificado: false,
      disponible: false,
    };
    if (dto.zona_nombre) prestadorData.zona_nombre = dto.zona_nombre;
    if (ubicacionBase) prestadorData.ubicacion_base = ubicacionBase;

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
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const bucket = BUCKET_MAP[tipo];
    const column = COLUMN_MAP[tipo];
    const fileName = `${userId}/${tipo}_${Date.now()}_${file.originalname}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file.buffer, { contentType: file.mimetype, upsert: true });

    if (uploadError) {
      this.logger.error(`Upload ${tipo} falló: ${uploadError.message}`);
      throw new BadRequestException(`Error subiendo ${tipo}: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName);
    const publicUrl = urlData.publicUrl;

    const { error: updateError } = await supabase
      .from('perfiles_prestadores')
      .update({ [column]: publicUrl })
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
    return { url: publicUrl, tipo };
  }

  // Mantener retrocompatibilidad con el endpoint /prestador/certificacion
  async uploadCertificacion(userId: string, file: Express.Multer.File, accessToken: string) {
    return this.uploadDocumento(userId, 'matricula', file, accessToken);
  }
}
