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
import { randomUUID } from 'crypto';

// Modo PROGRAMADO: plazo para postularse y tope de candidatos contactados.
export const POSTULACION_DEADLINE_MINUTES = 120;
export const MAX_CANDIDATOS_PROGRAMADO = 3;

// Foto del problema adjuntada al crear una solicitud — mismo bucket que evidencias
// (es el único bucket de Storage del proyecto), path propio para no mezclarlas.
const FOTO_PROBLEMA_BUCKET = process.env.EVIDENCIAS_BUCKET || 'evidencias';
const FOTO_PROBLEMA_MAX_BYTES = 3 * 1024 * 1024; // 3MB
const FOTO_PROBLEMA_SIGNED_URL_SECONDS = 60 * 60 * 24 * 30; // 30 días

// direccion_exacta/ubicacion_real viven en solicitudes_ubicacion_privada (RLS propia,
// fuera de la publicación realtime — ver F1 en el reporte de seguridad). Este embed
// las trae solo cuando el RLS de esa tabla lo permite (cliente dueño o prestador
// asignado); sanitizeLocation() las aplana de vuelta al shape plano que espera mobile.
const UBICACION_PRIVADA_EMBED =
  'ubicacion_privada:solicitudes_ubicacion_privada(direccion_exacta, ubicacion_real)';

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
      .select('rol, suspendido')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'cliente') {
      throw new ForbiddenException('Solo clientes pueden crear solicitudes');
    }
    if (profile.suspendido) {
      throw new ForbiddenException(
        'Tu cuenta está suspendida por cancelaciones repetidas. Contactá a soporte para más información.',
      );
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

    const esProgramado = dto.urgencia === 'programado';
    const timeoutAt = esProgramado
      ? null
      : new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const postulacionDeadlineAt = esProgramado
      ? new Date(
          Date.now() + POSTULACION_DEADLINE_MINUTES * 60 * 1000,
        ).toISOString()
      : null;

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .insert({
        cliente_id: userId,
        rubro_id: dto.rubro_id,
        descripcion: dto.descripcion,
        fotos_urls: dto.fotos_urls ?? [],
        tipo_tecnico: dto.tipo_tecnico,
        urgencia: dto.urgencia,
        franjas_horarias: dto.franjas_horarias ?? null,
        fecha_preferida: dto.fecha_preferida ?? null,
        zona_nombre: dto.zona_nombre,
        ubicacion_difusa: `POINT(${lonDif} ${latDif})`,
        estado: 'buscando',
        timeout_at: timeoutAt,
        postulacion_deadline_at: postulacionDeadlineAt,
        created_at: new Date().toISOString(),
      })
      .select(
        '*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)',
      )
      .single();

    if (error) {
      this.logger.error(`Error creando solicitud: ${error.message}`);
      throw new BadRequestException('No se pudo crear la solicitud');
    }

    // direccion_exacta/ubicacion_real viven en una tabla aparte (RLS propia,
    // fuera de la publicación realtime) — ver F1 en el reporte de seguridad.
    const { error: ubicacionError } = await supabase
      .from('solicitudes_ubicacion_privada')
      .insert({
        solicitud_id: data.id,
        direccion_exacta: dto.direccion_exacta,
        ubicacion_real: `POINT(${lon} ${lat})`,
      });

    if (ubicacionError) {
      this.logger.error(
        `Error guardando ubicación privada de la solicitud ${data.id}: ${ubicacionError.message}`,
      );
      await supabase.from('solicitudes_trabajo').delete().eq('id', data.id);
      throw new BadRequestException('No se pudo crear la solicitud');
    }

    data.direccion_exacta = dto.direccion_exacta;
    data.ubicacion_real = `POINT(${lon} ${lat})`;

    void this.notificationsService.notifyPrestadoresParaSolicitud(
      dto.rubro_id,
      lon,
      lat,
      accessToken,
      esProgramado
        ? {
            title: 'Nuevo trabajo programado',
            body: `Postulate y coordiná el precio por chat: ${dto.descripcion.substring(0, 90)}`,
            data: {
              solicitudId: data.id,
              rubroId: data.rubro_id,
              estado: data.estado,
            },
          }
        : {
            title: 'Nuevo trabajo disponible',
            body: dto.descripcion.substring(0, 120),
            data: {
              solicitudId: data.id,
              rubroId: data.rubro_id,
              estado: data.estado,
            },
          },
    );

    this.logger.log(`Solicitud creada: ${data.id}`);
    return { solicitud: data };
  }

  // ─── FOTO DEL PROBLEMA (previo a crear la solicitud) ──────────────────────

  async uploadFotoProblema(
    userId: string,
    file: Express.Multer.File,
    accessToken: string,
  ) {
    if (!file) throw new BadRequestException('File is required');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Solo se permiten imágenes');
    }
    if (file.size && file.size > FOTO_PROBLEMA_MAX_BYTES) {
      throw new BadRequestException('El archivo supera el máximo de 3MB');
    }

    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const extension = file.mimetype === 'image/png' ? 'png' : 'jpg';
    const storagePath = `solicitudes/${todayPrefix}/${userId}/${randomUUID()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from(FOTO_PROBLEMA_BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'image/jpeg',
        upsert: false,
      });

    if (uploadError) {
      this.logger.error(
        `Foto de problema: upload falló: ${uploadError.message}`,
      );
      throw new BadRequestException(
        'No se pudo subir la foto: ' + uploadError.message,
      );
    }

    // fotos_urls espera una URL usable directamente (no hay, a diferencia de
    // evidencias, un endpoint de lectura que regenere signed URLs a partir de un
    // path) — se firma con una duración larga en vez de persistir el path crudo.
    const { data: signedData, error: signedError } = await supabase.storage
      .from(FOTO_PROBLEMA_BUCKET)
      .createSignedUrl(storagePath, FOTO_PROBLEMA_SIGNED_URL_SECONDS);

    if (signedError || !signedData) {
      this.logger.error(
        `Foto de problema: no se pudo firmar la URL: ${signedError?.message}`,
      );
      throw new BadRequestException('No se pudo generar la URL de la foto');
    }

    return { url: signedData.signedUrl };
  }

  // ─── FIND ALL (por rol) ────────────────────────────────────────────────────

  async findAll(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol, suspendido')
      .eq('id', userId)
      .single();

    if (!profile) throw new BadRequestException('Perfil no encontrado');

    let query = supabase
      .from('solicitudes_trabajo')
      .select(
        `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), ${UBICACION_PRIVADA_EMBED}`,
      )
      .order('created_at', { ascending: false });

    if (profile.rol === 'cliente') {
      query = query.eq('cliente_id', userId);
    } else if (profile.rol === 'prestador') {
      if (profile.suspendido) return { solicitudes: [] };

      const { data: prestador } = await supabase
        .from('perfiles_prestadores')
        .select('esta_verificado, disponible')
        .eq('id', userId)
        .single();

      if (!prestador?.esta_verificado || !prestador?.disponible)
        return { solicitudes: [] };

      // Obtener los rubros del prestador
      const { data: rubros } = await supabase
        .from('prestador_rubros')
        .select('rubro_id')
        .eq('prestador_id', userId);

      const rubroIds = (rubros ?? []).map((r: any) => r.rubro_id);
      if (!rubroIds.length) return { solicitudes: [] };

      query = query.eq('estado', 'buscando').in('rubro_id', rubroIds);
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException('Error obteniendo solicitudes');

    let filtered = data ?? [];

    if (profile.rol === 'prestador') {
      const programadoIds = filtered
        .filter((d: any) => d.urgencia === 'programado')
        .map((d: any) => d.id);

      if (programadoIds.length) {
        const { data: misCandidaturas } = await supabase
          .from('solicitud_candidatos')
          .select('solicitud_id')
          .eq('prestador_id', userId)
          .in('solicitud_id', programadoIds);

        const yaPostuladoIds = new Set(
          (misCandidaturas ?? []).map((c: any) => c.solicitud_id),
        );

        // Para programado: no ofrecer de nuevo lo ya postulado, ni lo con cupo completo
        filtered = filtered.filter((d: any) => {
          if (d.urgencia !== 'programado') return true;
          if (yaPostuladoIds.has(d.id)) return false;
          return d.candidatos_count < MAX_CANDIDATOS_PROGRAMADO;
        });
      }
    }

    const canSeeExact = profile.rol === 'cliente';
    const sanitized = filtered.map((d: any) =>
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
      // Un prestador puede tener varios trabajos activos en simultáneo (no hay
      // límite de "un trabajo a la vez"), así que devolvemos todos, no solo el último.
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select(
          `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono), ${UBICACION_PRIVADA_EMBED}`,
        )
        .eq('prestador_id', userId)
        .in('estado', ['aceptado', 'en_camino', 'en_trabajo', 'finalizado'])
        .order('created_at', { ascending: false });

      if (error) {
        throw new BadRequestException('Error obteniendo trabajos activos');
      }
      // El prestador asignado siempre puede ver la dirección exacta de sus trabajos activos.
      return {
        solicitudes: (data ?? []).map((d: any) =>
          this.sanitizeLocation(d, true),
        ),
      };
    }

    if (profile?.rol === 'cliente') {
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select(
          `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre, telefono), ${UBICACION_PRIVADA_EMBED}`,
        )
        .eq('cliente_id', userId)
        .in('estado', [
          'buscando',
          'aceptado',
          'en_camino',
          'en_trabajo',
          'finalizado',
        ])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        throw new BadRequestException('Error obteniendo solicitud activa');
      }
      // El cliente dueño siempre puede ver la dirección exacta de su propio trabajo.
      return {
        solicitud: data ? this.sanitizeLocation(data, true) : null,
      };
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
      .select(
        `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), ${UBICACION_PRIVADA_EMBED}`,
      )
      .eq('prestador_id', userId)
      .in('estado', ['finalizado', 'cerrado'])
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException('Error obteniendo historial');

    // El prestador asignado siempre puede ver la dirección exacta de sus trabajos pasados.
    return {
      solicitudes: (data ?? []).map((d: any) => this.sanitizeLocation(d, true)),
    };
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
      .select(
        `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono), prestador:perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre), ${UBICACION_PRIVADA_EMBED}`,
      )
      .eq('id', id)
      .single();

    if (error) throw new NotFoundException('Solicitud no encontrada');

    const isCliente = data.cliente_id === userId;
    const isPrestadorAsignado = data.prestador_id === userId;

    let esCandidato = false;
    if (
      profile?.rol === 'prestador' &&
      data.urgencia === 'programado' &&
      !isPrestadorAsignado
    ) {
      const { data: candidatura } = await supabase
        .from('solicitud_candidatos')
        .select('id')
        .eq('solicitud_id', id)
        .eq('prestador_id', userId)
        .maybeSingle();
      esCandidato = !!candidatura;
    }

    // Si ya es candidato de esta solicitud, tiene acceso siempre — la postulación ya
    // es un hecho consumado, no depende de que siga verificado en este momento.
    // Si no es candidato, solo puede "visitar" solicitudes buscando estando verificado.
    const isPrestadorVisitante =
      profile?.rol === 'prestador' &&
      (esCandidato ||
        (prestadorProfile?.esta_verificado && data.estado === 'buscando'));

    if (!isCliente && !isPrestadorAsignado && !isPrestadorVisitante) {
      throw new ForbiddenException('Sin acceso a esta solicitud');
    }

    return {
      solicitud: this.sanitizeLocation(data, isCliente || isPrestadorAsignado),
    };
  }

  // ─── ACCEPT (prestador) ───────────────────────────────────────────────────

  async accept(solicitudId: string, prestadorId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Verificar perfil de prestador
    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol, suspendido')
      .eq('id', prestadorId)
      .single();

    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException('Solo prestadores pueden aceptar trabajos');
    }
    if (profile.suspendido) {
      throw new ForbiddenException(
        'Tu cuenta está suspendida por cancelaciones repetidas. Contactá a soporte para más información.',
      );
    }

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('esta_verificado, disponible')
      .eq('id', prestadorId)
      .single();

    if (!prestador?.esta_verificado) {
      throw new ForbiddenException(
        'Debes estar verificado para aceptar trabajos',
      );
    }
    if (!prestador?.disponible) {
      throw new ForbiddenException(
        'Debes estar disponible para aceptar trabajos',
      );
    }

    // Verificar que el rubro coincide
    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, rubro_id, estado, tipo_tecnico, urgencia')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');
    if (solicitud.urgencia === 'programado') {
      throw new ForbiddenException(
        'Esta solicitud usa el flujo de postulación con hasta 3 candidatos. Usá /postularse',
      );
    }
    if (solicitud.estado !== 'buscando') {
      throw new ConflictException(
        'Este trabajo ya fue tomado por otro técnico',
      );
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
        aceptado_at: new Date().toISOString(),
        timeout_at: null,
        timeout_notificado_at: null,
      })
      .eq('id', solicitudId)
      .eq('estado', 'buscando')
      .is('prestador_id', null)
      .select(`*, rubros(id, nombre, icono), ${UBICACION_PRIVADA_EMBED}`)
      .single();

    if (error || !updated) {
      throw new ConflictException(
        'Este trabajo ya fue tomado por otro técnico',
      );
    }

    void this.notificationsService.notifyUsers(
      [solicitud.cliente_id],
      'Técnico en camino',
      'Un técnico aceptó tu solicitud y se está preparando.',
      accessToken,
      { solicitudId, estado: 'aceptado' },
    );

    this.logger.log(
      `Solicitud ${solicitudId} aceptada por prestador ${prestadorId}`,
    );
    // El prestador recién asignado ya puede ver la dirección exacta.
    return { solicitud: this.sanitizeLocation(updated, true) };
  }

  // ─── POSTULARSE (prestador, solo modo programado) ────────────────────────

  async postularse(
    solicitudId: string,
    prestadorId: string,
    accessToken: string,
    presupuesto?: number,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol, suspendido')
      .eq('id', prestadorId)
      .single();

    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException(
        'Solo prestadores pueden postularse a trabajos',
      );
    }
    if (profile.suspendido) {
      throw new ForbiddenException(
        'Tu cuenta está suspendida por cancelaciones repetidas. Contactá a soporte para más información.',
      );
    }

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('esta_verificado, disponible')
      .eq('id', prestadorId)
      .single();

    if (!prestador?.esta_verificado) {
      throw new ForbiddenException('Debes estar verificado para postularte');
    }
    if (!prestador?.disponible) {
      throw new ForbiddenException('Debes estar disponible para postularte');
    }

    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, rubro_id, estado, urgencia')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');
    if (solicitud.urgencia !== 'programado') {
      throw new BadRequestException(
        'Esta solicitud no usa el flujo de postulación',
      );
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

    const { data: candidato, error } = await supabase.rpc(
      'postularse_a_solicitud',
      {
        p_solicitud_id: solicitudId,
        p_prestador_id: prestadorId,
        p_presupuesto: presupuesto ?? null,
      },
    );

    if (error) {
      if (error.message?.includes('ya_postulado')) {
        throw new ConflictException('Ya te postulaste a esta solicitud');
      }
      throw new ConflictException(
        'Cupo completo o la solicitud ya no acepta postulaciones',
      );
    }

    void this.notificationsService.notifyUsers(
      [solicitud.cliente_id],
      'Nueva propuesta recibida',
      'Un técnico se postuló a tu solicitud. Mirá su perfil y coordiná por chat.',
      accessToken,
      { solicitudId, estado: solicitud.estado },
    );

    this.logger.log(
      `Prestador ${prestadorId} se postuló a solicitud ${solicitudId}`,
    );
    return { candidato };
  }

  // ─── CANDIDATOS (cliente ve todos, prestador ve el propio) ──────────────

  async getCandidatos(
    solicitudId: string,
    userId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, urgencia')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');
    if (solicitud.urgencia !== 'programado') {
      throw new BadRequestException(
        'Esta solicitud no usa el flujo de postulación',
      );
    }

    const isCliente = solicitud.cliente_id === userId;

    let query = supabase
      .from('solicitud_candidatos')
      .select(
        '*, perfiles_prestadores(id, rating, trabajos_completados, foto_perfil_url, perfiles(id, nombre))',
      )
      .eq('solicitud_id', solicitudId)
      .order('created_at', { ascending: true });

    if (isCliente) {
      // el cliente ve los hasta 3 candidatos completos
    } else {
      // cualquier otro solo puede ver su propia postulación
      query = query.eq('prestador_id', userId);
    }

    const { data, error } = await query;
    if (error) throw new BadRequestException('Error obteniendo candidatos');

    if (!isCliente && !data?.length) {
      throw new ForbiddenException(
        'Sin acceso a los candidatos de esta solicitud',
      );
    }

    return { candidatos: data ?? [] };
  }

  // ─── ELEGIR CANDIDATO (cliente) ──────────────────────────────────────────

  async elegirCandidato(
    solicitudId: string,
    candidatoId: string,
    clienteId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, estado, urgencia')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');
    if (solicitud.cliente_id !== clienteId) {
      throw new ForbiddenException('Sin acceso a esta solicitud');
    }
    if (solicitud.urgencia !== 'programado') {
      throw new BadRequestException(
        'Esta solicitud no usa el flujo de postulación',
      );
    }

    const { data: candidato } = await supabase
      .from('solicitud_candidatos')
      .select('id, prestador_id, estado')
      .eq('id', candidatoId)
      .eq('solicitud_id', solicitudId)
      .single();

    if (!candidato || candidato.estado !== 'postulado') {
      throw new ConflictException('Este candidato ya no está disponible');
    }

    const { data: prestadorEstado } = await supabase
      .from('perfiles_prestadores')
      .select('esta_verificado, disponible')
      .eq('id', candidato.prestador_id)
      .single();

    if (!prestadorEstado?.esta_verificado || !prestadorEstado?.disponible) {
      throw new ConflictException(
        'Este técnico ya no está disponible. Elegí otro candidato.',
      );
    }

    const { data: updated, error } = await supabase
      .from('solicitudes_trabajo')
      .update({
        prestador_id: candidato.prestador_id,
        estado: 'aceptado',
        aceptado_at: new Date().toISOString(),
        timeout_at: null,
        timeout_notificado_at: null,
        postulacion_deadline_at: null,
      })
      .eq('id', solicitudId)
      .eq('estado', 'buscando')
      .is('prestador_id', null)
      .select(`*, rubros(id, nombre, icono), ${UBICACION_PRIVADA_EMBED}`)
      .single();

    if (error || !updated) {
      throw new ConflictException('Ya elegiste un técnico para este trabajo');
    }

    const decidedAt = new Date().toISOString();
    await supabase
      .from('solicitud_candidatos')
      .update({ estado: 'elegido', decided_at: decidedAt })
      .eq('id', candidatoId);

    const { data: descartados } = await supabase
      .from('solicitud_candidatos')
      .update({ estado: 'no_elegido', decided_at: decidedAt })
      .eq('solicitud_id', solicitudId)
      .neq('id', candidatoId)
      .eq('estado', 'postulado')
      .select('prestador_id');

    void this.notificationsService.notifyUsers(
      [candidato.prestador_id],
      '¡Fuiste elegido para este trabajo!',
      'El cliente te eligió. Coordiná los detalles finales por chat.',
      accessToken,
      { solicitudId, estado: 'aceptado' },
    );

    const descartadoIds = (descartados ?? [])
      .map((d: any) => d.prestador_id)
      .filter(Boolean);
    if (descartadoIds.length) {
      void this.notificationsService.notifyUsers(
        descartadoIds,
        'No fuiste elegido esta vez',
        'El cliente eligió a otro técnico para este trabajo.',
        accessToken,
        { solicitudId },
      );
    }

    this.logger.log(
      `Solicitud ${solicitudId}: candidato ${candidatoId} elegido por cliente ${clienteId}`,
    );
    // El cliente dueño ya podía ver la dirección exacta desde que la creó.
    return { solicitud: this.sanitizeLocation(updated, true) };
  }

  // ─── MIS POSTULACIONES (prestador) ───────────────────────────────────────

  async getMisPostulaciones(prestadorId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: candidaturas, error } = await supabase
      .from('solicitud_candidatos')
      .select(
        'id, estado, created_at, solicitud_id, solicitudes_trabajo(*, rubros(id, nombre, icono))',
      )
      .eq('prestador_id', prestadorId)
      .eq('estado', 'postulado')
      .order('created_at', { ascending: false });

    if (error)
      throw new BadRequestException('Error obteniendo tus postulaciones');

    // Si la solicitud padre ya no está "buscando" (se canceló, venció el timeout, etc.)
    // sin que se haya actualizado el estado del candidato, la postulación ya no es válida.
    const activas = (candidaturas ?? []).filter(
      (c: any) =>
        c.solicitudes_trabajo && c.solicitudes_trabajo.estado === 'buscando',
    );
    const candidatoIds = activas.map((c: any) => c.id);

    let noLeidosPorCandidato: Record<string, number> = {};
    if (candidatoIds.length) {
      const { data: noLeidos } = await supabase
        .from('mensajes')
        .select('candidato_id')
        .in('candidato_id', candidatoIds)
        .eq('read', false)
        .neq('sender_id', prestadorId);

      noLeidosPorCandidato = (noLeidos ?? []).reduce(
        (acc: Record<string, number>, m: any) => {
          acc[m.candidato_id] = (acc[m.candidato_id] ?? 0) + 1;
          return acc;
        },
        {},
      );
    }

    // F2: un candidato no elegido no debe recibir la dirección exacta del
    // cliente — sanitizeLocation(false) aplica el mismo criterio que
    // findAll/findOne (solo el cliente dueño o el prestador asignado la ven).
    return {
      postulaciones: activas.map((c: any) => ({
        ...this.sanitizeLocation(c.solicitudes_trabajo, false),
        candidato_id: c.id,
        mensajes_no_leidos: noLeidosPorCandidato[c.id] ?? 0,
      })),
    };
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

    if (fetchError || !solicitud)
      throw new NotFoundException('Solicitud no encontrada');

    const isCliente = solicitud.cliente_id === userId;
    const isPrestador = solicitud.prestador_id === userId;

    if (!isCliente && !isPrestador) {
      throw new ForbiddenException('Sin acceso a esta solicitud');
    }

    // Reglas por rol
    if (
      (dto.estado === 'en_camino' ||
        dto.estado === 'en_trabajo' ||
        dto.estado === 'finalizado') &&
      !isPrestador
    ) {
      throw new ForbiddenException(
        'Solo el prestador asignado puede actualizar a este estado',
      );
    }
    if (dto.estado === 'cerrado' && !isCliente) {
      throw new ForbiddenException('Solo el cliente puede cerrar la solicitud');
    }

    // Transiciones válidas: aceptado→en_camino | en_camino→en_trabajo (RQ-09, "llegué") |
    // aceptado/en_camino/en_trabajo→finalizado | finalizado→cerrado
    const validTransitions: Record<string, string[]> = {
      aceptado: ['en_camino', 'finalizado'],
      en_camino: ['en_trabajo', 'finalizado'],
      en_trabajo: ['finalizado'],
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
      .select(
        `*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), ${UBICACION_PRIVADA_EMBED}`,
      )
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        throw new ConflictException(
          'Estado modificado por otro proceso. Reintentá.',
        );
      }
      throw new BadRequestException('Error actualizando estado');
    }

    // Evidencias: poner fecha de expiración a los 3 días si finalizado
    if (dto.estado === 'finalizado') {
      const expiresAt = new Date(
        Date.now() + 3 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await supabase
        .from('evidencias')
        .update({ expires_at: expiresAt })
        .eq('trabajo_id', id)
        .eq('es_reclamo', false);

      // Promo de lanzamiento: descuenta un crédito de trabajo gratis (tope 3, atómico vía RPC)
      if (solicitud.prestador_id) {
        const serviceSupabase = this.supabaseService.getServiceClient();
        const { error: creditoError } = await serviceSupabase.rpc(
          'increment_trabajos_gratis_usados',
          { p_prestador_id: solicitud.prestador_id },
        );
        if (creditoError) {
          this.logger.error(
            `Error descontando crédito de promo para prestador ${solicitud.prestador_id}: ${creditoError.message}`,
          );
        }
      }
    }

    // Notificar a la contraparte
    const notifyTarget = isPrestador
      ? solicitud.cliente_id
      : solicitud.prestador_id;
    if (notifyTarget) {
      const messages: Record<string, { title: string; body: string }> = {
        en_camino: {
          title: 'El técnico está en camino',
          body: 'Tu técnico confirmó que ya va hacia tu domicilio.',
        },
        en_trabajo: {
          title: 'El técnico llegó',
          body: 'Tu técnico llegó y ya está trabajando en tu solicitud.',
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
    // El caller ya fue verificado como cliente dueño o prestador asignado (línea ~862).
    return { solicitud: this.sanitizeLocation(data, true) };
  }

  // ─── CANCEL (cliente o prestador; 'buscando' solo cliente, 'aceptado' ambos) ─
  // CAN-02/03/04: cancelar en 'aceptado' suma un strike a quien cancela salvo que
  // sea un trabajo no urgente cancelado dentro de las 12hs de aceptado. 3 strikes
  // suspenden la cuenta. Si cancela el prestador, el trabajo vuelve a 'buscando'
  // (no se cancela del todo) para que otro lo pueda tomar.

  async cancel(solicitudId: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'cliente' && profile?.rol !== 'prestador') {
      throw new ForbiddenException(
        'Solo clientes o prestadores pueden cancelar solicitudes',
      );
    }
    const isPrestador = profile.rol === 'prestador';

    const { data: solicitud } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, prestador_id, estado, urgencia, aceptado_at')
      .eq('id', solicitudId)
      .single();

    if (!solicitud) throw new NotFoundException('Solicitud no encontrada');

    const isOwner = isPrestador
      ? solicitud.prestador_id === userId
      : solicitud.cliente_id === userId;
    if (!isOwner)
      throw new ForbiddenException('No tenés permiso sobre esta solicitud');

    // El prestador solo puede "cancelar" un trabajo que ya tiene aceptado —
    // en 'buscando' todavía no está asignado a nadie.
    const estadosCancelables = isPrestador
      ? ['aceptado']
      : ['buscando', 'aceptado'];
    if (!estadosCancelables.includes(solicitud.estado)) {
      throw new BadRequestException(
        `Solo se puede cancelar en estado ${estadosCancelables.join(' o ')}. Estado actual: ${solicitud.estado}`,
      );
    }

    // ── CAN-02/04: ¿esta cancelación suma un strike? ──
    let sumaStrike = false;
    if (solicitud.estado === 'aceptado') {
      const esUrgente = solicitud.urgencia !== 'programado';
      if (esUrgente) {
        sumaStrike = true;
      } else if (solicitud.aceptado_at) {
        const horasTranscurridas =
          (Date.now() - new Date(solicitud.aceptado_at).getTime()) /
          (1000 * 60 * 60);
        sumaStrike = horasTranscurridas > 12;
      }
      // Sin aceptado_at (dato legacy) no se puede probar que pasaron +12hs — no se penaliza.
    }

    // ── Update atómico: el cliente cancela de verdad; el prestador libera el trabajo ──
    const esProgramado = solicitud.urgencia === 'programado';
    let updatePayload: Record<string, any>;
    if (isPrestador) {
      updatePayload = {
        estado: 'buscando',
        prestador_id: null,
        aceptado_at: null,
      };
      if (esProgramado) {
        // Reabrir el pool de candidatos: sin esto, candidatos_count ya maxeado
        // o el deadline ya vencido dejarían el trabajo inalcanzable para siempre.
        updatePayload.candidatos_count = 0;
        updatePayload.postulacion_deadline_at = new Date(
          Date.now() + POSTULACION_DEADLINE_MINUTES * 60 * 1000,
        ).toISOString();
      } else {
        updatePayload.timeout_at = new Date(
          Date.now() + 10 * 60 * 1000,
        ).toISOString();
      }
    } else {
      updatePayload = { estado: 'cancelado' };
    }

    let query = supabase
      .from('solicitudes_trabajo')
      .update(updatePayload)
      .eq('id', solicitudId)
      .eq('estado', solicitud.estado);
    query = isPrestador
      ? query.eq('prestador_id', userId)
      : query.eq('cliente_id', userId);

    const { data: updated, error } = await query
      .select('id, estado, cliente_id, prestador_id')
      .single();

    if (error && error.code === 'PGRST116') {
      throw new ConflictException(
        'El estado de la solicitud cambió antes de poder cancelarla. Refrescá el detalle e intentá de nuevo.',
      );
    }
    if (error) {
      this.logger.error(
        `Error cancelando solicitud ${solicitudId}: ${error.message} (code: ${error.code})`,
      );
      throw new BadRequestException(
        `Error cancelando la solicitud: ${error.message}`,
      );
    }

    // Si cancela el prestador, se repone su disponibilidad (por si quedó en false
    // por inactividad u otro motivo mientras tenía este trabajo activo).
    if (isPrestador) {
      await supabase
        .from('perfiles_prestadores')
        .update({ disponible: true })
        .eq('id', userId);
    }

    // ── Notificar a la contraparte ──
    if (!isPrestador) {
      if (solicitud.estado === 'buscando') {
        const { data: candidatosActivos } = await supabase
          .from('solicitud_candidatos')
          .select('prestador_id')
          .eq('solicitud_id', solicitudId)
          .eq('estado', 'postulado');

        const candidatoIds = (candidatosActivos ?? [])
          .map((c: any) => c.prestador_id)
          .filter(Boolean);
        if (candidatoIds.length) {
          void this.notificationsService.notifyUsers(
            candidatoIds,
            'Solicitud cancelada',
            'El cliente canceló la solicitud a la que te habías postulado.',
            accessToken,
            { solicitudId },
          );
        }
      } else if (solicitud.prestador_id) {
        void this.notificationsService.notifyUsers(
          [solicitud.prestador_id],
          'El cliente canceló el trabajo',
          'El cliente canceló la solicitud que tenías aceptada.',
          accessToken,
          { solicitudId },
        );
      }
    } else {
      void this.notificationsService.notifyUsers(
        [solicitud.cliente_id],
        'El técnico canceló el trabajo',
        'Tu técnico canceló el trabajo. Estamos buscando otro disponible.',
        accessToken,
        { solicitudId, estado: 'buscando' },
      );
    }

    // ── Aplicar el strike (si corresponde) y evaluar suspensión ──
    let strikeAplicado = false;
    let cuentaSuspendida = false;
    if (sumaStrike) {
      const serviceSupabase = this.supabaseService.getServiceClient();
      const { data: strikeData, error: strikeError } =
        await serviceSupabase.rpc('increment_strikes', {
          p_perfil_id: userId,
        });
      if (strikeError) {
        this.logger.error(
          `Error incrementando strikes de ${userId}: ${strikeError.message}`,
        );
      } else {
        strikeAplicado = true;
        const row = Array.isArray(strikeData) ? strikeData[0] : strikeData;
        cuentaSuspendida = !!row?.suspendido;

        const esUrgente = solicitud.urgencia !== 'programado';
        const motivo = esUrgente
          ? 'Cancelaste un trabajo urgente ya aceptado'
          : 'Cancelaste un trabajo no urgente más de 12hs después de aceptarlo';
        const { error: historialError } = await serviceSupabase
          .from('strikes_historial')
          .insert({
            perfil_id: userId,
            trabajo_id: solicitudId,
            motivo,
          });
        if (historialError) {
          this.logger.error(
            `Error guardando historial de strike de ${userId}: ${historialError.message}`,
          );
        }

        if (cuentaSuspendida) {
          this.logger.warn(
            `Cuenta ${userId} suspendida tras acumular ${row.strikes_count} strikes por cancelaciones`,
          );
          void this.notificationsService.notifyUsers(
            [userId],
            'Tu cuenta fue suspendida',
            'Acumulaste 3 cancelaciones con penalización. Contactá a soporte para más información.',
            accessToken,
            {},
          );
        }
      }
    }

    this.logger.log(
      `Solicitud ${solicitudId} cancelada por ${profile.rol} ${userId}${sumaStrike ? ' (con strike)' : ''}`,
    );
    return {
      solicitud: updated,
      strike_aplicado: strikeAplicado,
      cuenta_suspendida: cuentaSuspendida,
    };
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  // direccion_exacta/ubicacion_real llegan (si acaso) anidadas bajo
  // `ubicacion_privada` (embed a solicitudes_ubicacion_privada, RLS propia — ver
  // F1). Esta función las aplana de vuelta al shape plano que espera mobile,
  // y solo cuando canSeeExact es true — nunca confía en si el embed vino o no
  // vino (RLS ya lo filtró aguas arriba, pero el criterio de la app es la
  // fuente de verdad para decidir qué exponer).
  private sanitizeLocation(solicitud: any, canSeeExact: boolean) {
    const { ubicacion_privada, ...rest } = solicitud;

    if (canSeeExact) {
      return {
        ...rest,
        direccion_exacta: ubicacion_privada?.direccion_exacta ?? null,
        ubicacion_real: ubicacion_privada?.ubicacion_real ?? null,
      };
    }

    const approx = solicitud.ubicacion_difusa
      ? this.parsePoint(solicitud.ubicacion_difusa)
      : null;
    const approxLabel = approx
      ? `Área aprox: ${approx.lon.toFixed(3)}, ${approx.lat.toFixed(3)} (±500m)`
      : null;

    return {
      ...rest,
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
      throw new BadRequestException(
        'Formato de coordenadas inválido. Usar "lon,lat"',
      );
    }
    return { lon: parts[0], lat: parts[1] };
  }

  private parsePoint(value: any): { lon: number; lat: number } | null {
    if (!value) return null;
    if (typeof value === 'object' && Array.isArray(value.coordinates)) {
      const [lon, lat] = value.coordinates;
      if (!Number.isNaN(lon) && !Number.isNaN(lat))
        return { lon: Number(lon), lat: Number(lat) };
    }
    const str = String(value);
    const m = str.match(/POINT\((-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\)/i);
    if (m) return { lon: Number(m[1]), lat: Number(m[2]) };
    const m2 = str.match(/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
    if (m2) return { lon: Number(m2[1]), lat: Number(m2[2]) };
    return null;
  }
}
