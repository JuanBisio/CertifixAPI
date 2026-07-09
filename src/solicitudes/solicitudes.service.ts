import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateSolicitudDto } from './dto/create-solicitud.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class SolicitudesService {
  private readonly logger = new Logger(SolicitudesService.name);

  constructor(
    private supabaseService: SupabaseService,
    private notificationsService: NotificationsService,
  ) {}

  // ─── CREATE ───────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateSolicitudDto, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'cliente') {
      throw new ForbiddenException('Solo clientes pueden crear solicitudes');
    }

    const { data: rubro } = await supabase
      .from('rubros')
      .select('id')
      .eq('id', dto.rubro_id)
      .single();

    if (!rubro) {
      throw new BadRequestException('rubro_id inválido');
    }

    const { lon, lat } = this.parseCoords(dto.coordenadas_privadas);
    const { lon: lonDif, lat: latDif } = this.parseCoords(
      dto.coordenadas_publicas ?? dto.coordenadas_privadas,
    );

    const timeoutAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .insert({
        cliente_id: userId,
        rubro_id: dto.rubro_id,
        descripcion: dto.descripcion,
        fotos_urls: dto.fotos_urls ?? [],
        tipo_tecnico: dto.tipo_tecnico,
        urgencia: dto.urgencia,
        franja_horaria: dto.franja_horaria ?? null,
        fecha_preferida: dto.fecha_preferida ?? null,
        direccion_exacta: dto.direccion_exacta,
        zona_nombre: dto.zona_nombre,
        ubicacion_real: `POINT(${lon} ${lat})`,
        ubicacion_difusa: `POINT(${lonDif} ${latDif})`,
        estado: 'buscando',
        timeout_at: timeoutAt,
        created_at: new Date().toISOString(),
      })
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
      .single();

    if (error) {
      this.logger.error(`Error creando solicitud: ${error.message}`);
      throw new BadRequestException('No se pudo crear la solicitud');
    }

    void this.notificationsService.notifyPrestadoresParaSolicitud(
      dto.rubro_id,
      lon,
      lat,
      accessToken,
      {
        title: 'Nuevo trabajo disponible',
        body: dto.descripcion.substring(0, 120),
        data: { solicitudId: data.id, rubroId: data.rubro_id, estado: data.estado },
      },
    );

    this.logger.log(`Solicitud creada: ${data.id}`);
    return { solicitud: data };
  }

  // ─── FIND ALL (por rol) ────────────────────────────────────────────────────

  async findAll(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (!profile) throw new BadRequestException('Perfil no encontrado');

    let query = supabase
      .from('solicitudes_trabajo')
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
      .order('created_at', { ascending: false });

    if (profile.rol === 'cliente') {
      query = query.eq('cliente_id', userId);
    } else if (profile.rol === 'prestador') {
      const { data: prestador } = await supabase
        .from('perfiles_prestadores')
        .select('esta_verificado')
        .eq('id', userId)
        .single();

      if (!prestador?.esta_verificado) return { solicitudes: [] };

      // Obtener los rubros del prestador
      const { data: rubros } = await supabase
        .from('prestador_rubros')
        .select('rubro_id')
        .eq('prestador_id', userId);

      const rubroIds = (rubros ?? []).map((r: any) => r.rubro_id);
      if (!rubroIds.length) return { solicitudes: [] };

      query = query
        .eq('estado', 'buscando')
        .in('rubro_id', rubroIds);
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException('Error obteniendo solicitudes');

    const canSeeExact = profile.rol === 'cliente';
    const sanitized = (data ?? []).map((d: any) =>
      this.sanitizeLocation(d, canSeeExact || d.prestador_id === userId),
    );

    return { solicitudes: sanitized };
  }

  // ─── MY ACTIVE (prestador) ────────────────────────────────────────────────

  async getMyActive(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol === 'prestador') {
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono)')
        .eq('prestador_id', userId)
        .in('estado', ['aceptado', 'en_camino', 'finalizado'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw new BadRequestException('Error obteniendo trabajo activo');
      }
      return { solicitud: data ?? null };
    }

    if (profile?.rol === 'cliente') {
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre, telefono)')
        .eq('cliente_id', userId)
        .in('estado', ['buscando', 'aceptado', 'en_camino', 'finalizado'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw new BadRequestException('Error obteniendo solicitud activa');
      }
      return { solicitud: data ?? null };
    }

    throw new ForbiddenException('Rol no válido para este endpoint');
  }

  // ─── HISTORY (prestador) ──────────────────────────────────────────────────

  async getHistory(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException('Solo prestadores pueden ver el historial');
    }

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
      .eq('prestador_id', userId)
      .in('estado', ['finalizado', 'cerrado'])
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException('Error obteniendo historial');

    return { solicitudes: data ?? [] };
  }

  // ─── FIND ONE ─────────────────────────────────────────────────────────────

  async findOne(id: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    let prestadorProfile: any = null;
    if (profile?.rol === 'prestador') {
      const { data } = await supabase
        .from('perfiles_prestadores')
        .select('esta_verificado')
        .eq('id', userId)
        .single();
      prestadorProfile = data;
    }

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono)')
      .eq('id', id)
      .single();

    if (error) throw new NotFoundException('Solicitud no encontrada');

    const isCliente = data.cliente_id === userId;
    const isPrestadorAsignado = data.prestador_id === userId;
    const isPrestadorVisitante =
      profile?.rol === 'prestador' &&
      data.estado === 'buscando' &&
      prestadorProfile?.esta_verificado;

    if (!isCliente && !isPrestadorAsignado && !isPrestadorVisitante) {
      throw new ForbiddenException('Sin acceso a esta solicitud');
    }

    return { solicitud: this.sanitizeLocation(data, isCliente || isPrestadorAsignado) };
  }

  // ─── ACCEPT (prestador) ───────────────────────────────────────────────────

  async accept(solicitudId: string, prestadorId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Verificar perfil de prestador
    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', prestadorId)
      .single();

    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException('Solo prestadores pueden aceptar trabajos');
    }

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('esta_verificado, disponible')
      .eq('id', prestadorId)
      .single();

    if (!prestador?.esta_verificado) {
      throw new ForbiddenException('Debes estar verificado para aceptar trabajos');
    }
    if (!prestador?.disponible) {
      throw new ForbiddenException('Debes estar disponible para aceptar trabajos');
    }

    // Verificar que el rubro coincide
    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, rubro_id, estado, tipo_tecnico')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');
    if (solicitud.estado !== 'buscando') {
      throw new ConflictException('Este trabajo ya fue tomado por otro técnico');
    }

    const { data: rubroMatch } = await supabase
      .from('prestador_rubros')
      .select('id')
      .eq('prestador_id', prestadorId)
      .eq('rubro_id', solicitud.rubro_id)
      .single();

    if (!rubroMatch) {
      throw new ForbiddenException('El trabajo no coincide con tus rubros');
    }

    // Aceptación atómica — solo el primero gana
    const { data: updated, error } = await supabase
      .from('solicitudes_trabajo')
      .update({
        prestador_id: prestadorId,
        estado: 'aceptado',
        timeout_at: null,
        timeout_notificado_at: null,
      })
      .eq('id', solicitudId)
      .eq('estado', 'buscando')
      .is('prestador_id', null)
      .select('*, rubros(id, nombre, icono)')
      .single();

    if (error || !updated) {
      throw new ConflictException('Este trabajo ya fue tomado por otro técnico');
    }

    void this.notificationsService.notifyUsers(
      [solicitud.cliente_id],
      'Técnico en camino',
      'Un técnico aceptó tu solicitud y se está preparando.',
      accessToken,
      { solicitudId, estado: 'aceptado' },
    );

    this.logger.log(`Solicitud ${solicitudId} aceptada por prestador ${prestadorId}`);
    return { solicitud: updated };
  }

  // ─── UPDATE STATUS ────────────────────────────────────────────────────────

  async updateStatus(
    id: string,
    userId: string,
    dto: UpdateStatusDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: solicitud, error: fetchError } = await supabase
      .from('solicitudes_trabajo')
      .select('*, rubros(id, nombre, icono)')
      .eq('id', id)
      .single();

    if (fetchError || !solicitud) throw new NotFoundException('Solicitud no encontrada');

    const isCliente = solicitud.cliente_id === userId;
    const isPrestador = solicitud.prestador_id === userId;

    if (!isCliente && !isPrestador) {
      throw new ForbiddenException('Sin acceso a esta solicitud');
    }

    // Reglas por rol
    if ((dto.estado === 'en_camino' || dto.estado === 'finalizado') && !isPrestador) {
      throw new ForbiddenException('Solo el prestador asignado puede actualizar a este estado');
    }
    if (dto.estado === 'cerrado' && !isCliente) {
      throw new ForbiddenException('Solo el cliente puede cerrar la solicitud');
    }

    // Transiciones válidas: aceptado→en_camino | aceptado/en_camino→finalizado | finalizado→cerrado
    const validTransitions: Record<string, string[]> = {
      aceptado: ['en_camino', 'finalizado'],
      en_camino: ['finalizado'],
      finalizado: ['cerrado'],
    };

    const current = solicitud.estado;
    if (!validTransitions[current]?.includes(dto.estado)) {
      throw new BadRequestException(
        `Transición inválida: ${current} → ${dto.estado}`,
      );
    }

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .update({ estado: dto.estado })
      .eq('id', id)
      .eq('estado', current)
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new ConflictException('Estado modificado por otro proceso. Reintentá.');
      }
      throw new BadRequestException('Error actualizando estado');
    }

    // Evidencias: poner fecha de expiración a los 3 días si finalizado
    if (dto.estado === 'finalizado') {
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('evidencias')
        .update({ expires_at: expiresAt })
        .eq('trabajo_id', id)
        .eq('es_reclamo', false);
    }

    // Notificar a la contraparte
    const notifyTarget = isPrestador ? solicitud.cliente_id : solicitud.prestador_id;
    if (notifyTarget) {
      const messages: Record<string, { title: string; body: string }> = {
        en_camino: {
          title: 'El técnico está en camino',
          body: 'Tu técnico confirmó que ya va hacia tu domicilio.',
        },
        finalizado: {
          title: 'Trabajo finalizado',
          body: 'El técnico marcó el trabajo como finalizado. Revisá la evidencia y cerrá la solicitud.',
        },
        cerrado: {
          title: 'Solicitud cerrada',
          body: 'El cliente cerró la solicitud. ¡Gracias por usar CertiFix!',
        },
      };
      const msg = messages[dto.estado];
      if (msg) {
        void this.notificationsService.notifyUsers(
          [notifyTarget],
          msg.title,
          msg.body,
          accessToken,
          { solicitudId: id, estado: dto.estado },
        );
      }
    }

    this.logger.log(`Solicitud ${id}: ${current} → ${dto.estado}`);
    return { solicitud: data };
  }

  // ─── CANCEL (cliente, solo en estado buscando) ───────────────────────────

  async cancel(solicitudId: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'cliente') {
      throw new ForbiddenException('Solo clientes pueden cancelar solicitudes');
    }

    const { data: updated, error } = await supabase
      .from('solicitudes_trabajo')
      .update({ estado: 'cancelado' })
      .eq('id', solicitudId)
      .eq('cliente_id', userId)
      .eq('estado', 'buscando')
      .select('id, estado')
      .single();

    if (error && error.code === 'PGRST116') {
      const { data: existing } = await supabase
        .from('solicitudes_trabajo')
        .select('estado, cliente_id')
        .eq('id', solicitudId)
        .single();

      if (!existing) throw new NotFoundException('Solicitud no encontrada');
      if (existing.cliente_id !== userId) throw new ForbiddenException('No tenés permiso sobre esta solicitud');
      throw new BadRequestException(
        `Solo se puede cancelar en estado buscando. Estado actual: ${existing.estado}`,
      );
    }

    if (error) {
      this.logger.error(`Error cancelando solicitud ${solicitudId}: ${error.message} (code: ${error.code})`);
      throw new BadRequestException(`Error cancelando la solicitud: ${error.message}`);
    }

    this.logger.log(`Solicitud ${solicitudId} cancelada por cliente ${userId}`);
    return { solicitud: updated };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  private sanitizeLocation(solicitud: any, canSeeExact: boolean) {
    if (canSeeExact) return solicitud;

    const approx = solicitud.ubicacion_difusa
      ? this.parsePoint(solicitud.ubicacion_difusa)
      : null;
    const approxLabel = approx
      ? `Área aprox: ${approx.lon.toFixed(3)}, ${approx.lat.toFixed(3)} (±500m)`
      : null;

    return {
      ...solicitud,
      direccion_exacta: null,
      coordenadas_privadas: null,
      ubicacion_real: null,
      ubicacion: solicitud.zona_nombre ?? approxLabel ?? 'Ubicación a convenir',
    };
  }

  private parseCoords(value: string): { lon: number; lat: number } {
    if (!value) throw new BadRequestException('Coordenadas requeridas');
    const parts = value.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) {
      throw new BadRequestException('Formato de coordenadas inválido. Usar "lon,lat"');
    }
    return { lon: parts[0], lat: parts[1] };
  }

  private parsePoint(value: any): { lon: number; lat: number } | null {
    if (!value) return null;
    if (typeof value === 'object' && Array.isArray(value.coordinates)) {
      const [lon, lat] = value.coordinates;
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) return { lon: Number(lon), lat: Number(lat) };
    }
    const str = String(value);
    const m = str.match(/POINT\((-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/i);
    if (m) return { lon: Number(m[1]), lat: Number(m[2]) };
    const m2 = str.match(/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m2) return { lon: Number(m2[1]), lat: Number(m2[2]) };
    return null;
  }
}
