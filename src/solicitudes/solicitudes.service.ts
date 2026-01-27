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
import { CreatePostulacionDto } from './dto/create-postulacion.dto';

@Injectable()
export class SolicitudesService {
  private readonly logger = new Logger(SolicitudesService.name);

  constructor(
    private supabaseService: SupabaseService,
    private notificationsService: NotificationsService,
  ) {}

  async create(
    userId: string,
    createSolicitudDto: CreateSolicitudDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Verify user is a cliente
      const { data: profile } = await supabase
        .from('perfiles')
        .select('rol')
        .eq('id', userId)
        .single();

      if (profile?.rol !== 'cliente') {
        throw new ForbiddenException('Only clientes can create work requests');
      }

      // Verify rubro exists
      const { data: rubro } = await supabase
        .from('rubros')
        .select('id')
        .eq('id', createSolicitudDto.rubro_id)
        .single();

      if (!rubro) {
        throw new BadRequestException('Invalid rubro_id');
      }

      // Parse coords
      const { lon, lat } = this.parseCoords(createSolicitudDto.coordenadas_privadas);
      const { lon: lonDif, lat: latDif } = this.parseCoords(
        (createSolicitudDto as any).coordenadas_publicas || createSolicitudDto.coordenadas_privadas,
      );

      // Create solicitud
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .insert({
          cliente_id: userId,
          rubro_id: createSolicitudDto.rubro_id,
          descripcion: createSolicitudDto.descripcion,
          direccion_exacta: createSolicitudDto.direccion_exacta,
          zona_nombre: createSolicitudDto.zona_nombre,
          ubicacion_real: `POINT(${lon} ${lat})`,
          ubicacion_difusa: `POINT(${lonDif} ${latDif})`,
          estado: 'buscando',
          fecha_desde: (createSolicitudDto as any).fecha_desde,
          fecha_hasta: (createSolicitudDto as any).fecha_hasta,
          created_at: new Date().toISOString(),
        })
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
        .single();

      if (error) {
        this.logger.error(`Failed to create solicitud: ${error.message}`);
        throw new BadRequestException('Failed to create work request');
      }

      // Notify prestadores del rubro disponibles y verificados
      void this.notificationsService.notifyPrestadoresForRubro(
        createSolicitudDto.rubro_id,
        accessToken,
        {
          title: 'Nuevo trabajo disponible',
          body: createSolicitudDto.descripcion.substring(0, 120),
          data: {
            solicitudId: data.id,
            rubroId: data.rubro_id,
            estado: data.estado,
          },
        },
      );

      this.logger.log(`Solicitud created: ${data.id}`);
      return { solicitud: data };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Create solicitud error: ${error.message}`);
      throw new BadRequestException('Failed to create work request');
    }
  }

  async findAll(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Get user profile
      const { data: profile } = await supabase
        .from('perfiles')
        .select('rol')
        .eq('id', userId)
        .single();

      if (!profile) {
        throw new BadRequestException('Profile not found');
      }

      let query = supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
        .order('created_at', { ascending: false });

      if (profile.rol === 'cliente') {
        query = query.eq('cliente_id', userId);
      } else if (profile.rol === 'prestador') {
        const { data: prestador } = await supabase
          .from('perfiles_prestadores')
          .select('rubro_id, esta_verificado')
          .eq('id', userId)
          .single();

        if (!prestador) {
          throw new ForbiddenException('Prestador profile not found');
        }

        if (!prestador.esta_verificado) {
          return { solicitudes: [] };
        }

        query = query
          .eq('estado', 'buscando')
          .eq('rubro_id', prestador.rubro_id);
      }

      const { data, error } = await query;

      if (error) {
        this.logger.error(`Failed to fetch solicitudes: ${error.message}`);
        throw new BadRequestException('Failed to fetch work requests');
      }

      const canSeeExactForIds = new Set<string>();
      if (profile.rol === 'cliente') {
        (data || []).forEach((d: any) => canSeeExactForIds.add(d.id));
      }

      const sanitized = (data || []).map((d: any) =>
        this.sanitizeLocation(
          d,
          canSeeExactForIds.has(d.id) || d.prestador_id === userId,
        ),
      );

      return { solicitudes: sanitized };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Find all solicitudes error: ${error.message}`);
      throw new BadRequestException('Failed to fetch work requests');
    }
  }

  async getMyActive(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Verify user is prestador
      const { data: profile } = await supabase
        .from('perfiles')
        .select('rol')
        .eq('id', userId)
        .single();

      if (profile?.rol !== 'prestador') {
        throw new ForbiddenException('Only prestadores can view active work');
      }

      // Get active solicitud
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono)')
        .eq('prestador_id', userId)
        .in('estado', ['aceptado', 'pagado', 'finalizado'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (error && error.code !== 'PGRST116') {
        // PGRST116 is "no rows returned" which is fine
        this.logger.error(`Failed to fetch active work: ${error.message}`);
        throw new BadRequestException('Failed to fetch active work');
      }

      return { solicitud: data || null };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Get my active error: ${error.message}`);
      throw new BadRequestException('Failed to fetch active work');
    }
  }

  async getHistory(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    
    // Verify prestador
    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', userId)
      .single();

    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException('Only prestadores can access history');
    }

    const { data, error } = await supabase
      .from('solicitudes_trabajo')
      .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
      .eq('prestador_id', userId)
      .in('estado', ['finalizado', 'cerrado'])
      .order('updated_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch history: ${error.message}`);
      throw new BadRequestException('Failed to fetch history');
    }

    return { solicitudes: data || [] };
  }

  async findOne(id: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Identify requester role and, if prestador, its rubro/verification
      const { data: profile } = await supabase
        .from('perfiles')
        .select('rol')
        .eq('id', userId)
        .single();

      let prestadorProfile: any = null;
      if (profile?.rol === 'prestador') {
        const { data: prest } = await supabase
          .from('perfiles_prestadores')
          .select('rubro_id, esta_verificado')
          .eq('id', userId)
          .single();
        prestadorProfile = prest;
      }

      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre, telefono)')
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error(`Failed to fetch solicitud: ${error.message}`);
        throw new NotFoundException('Work request not found');
      }

      // Access rules:
      // - Cliente owner can see
      // - Prestador assigned can see
      // - Prestador verificado puede ver trabajos en estado buscando (sin ubicación exacta)
      const isCliente = data.cliente_id === userId;
      const isPrestadorAsignado = data.prestador_id === userId;
      const isPrestadorPendienteVisible =
        profile?.rol === 'prestador' &&
        data.estado === 'buscando' &&
        prestadorProfile?.esta_verificado &&
        prestadorProfile?.rubro_id === data.rubro_id;

      if (!isCliente && !isPrestadorAsignado && !isPrestadorPendienteVisible) {
        throw new ForbiddenException('Access denied to this work request');
      }

      let mi_postulacion = null;
      if (profile?.rol === 'prestador') {
        const { data: propia } = await supabase
          .from('postulaciones')
          .select('*')
          .eq('trabajo_id', id)
          .eq('prestador_id', userId)
          .single();
        mi_postulacion = propia || null;
      }

      const sanitized = this.sanitizeLocation(data, isCliente || isPrestadorAsignado);

      return { solicitud: { ...sanitized, mi_postulacion } };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Find one solicitud error: ${error.message}`);
      throw new NotFoundException('Work request not found');
    }
  }

  // Postularse a un trabajo (prestador)
  async createPostulacion(
    trabajoId: string,
    prestadorId: string,
    dto: CreatePostulacionDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Validaciones básicas
    const { data: profile } = await supabase
      .from('perfiles')
      .select('rol')
      .eq('id', prestadorId)
      .single();
    if (profile?.rol !== 'prestador') {
      throw new ForbiddenException('Solo prestadores pueden postularse');
    }

    const { data: prestador, error: prestError } = await supabase
      .from('perfiles_prestadores')
      .select('rubro_id, esta_verificado, disponible')
      .eq('id', prestadorId)
      .single();
    if (prestError || !prestador) {
      throw new ForbiddenException('Perfil de prestador no encontrado');
    }
    if (!prestador.esta_verificado) {
      throw new ForbiddenException('Debes estar verificado para postularte');
    }
    if (!prestador.disponible) {
      throw new ForbiddenException('Activa tu disponibilidad para postularte');
    }

    // Trabajo debe existir y estar buscando
    const { data: trabajo } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, estado, rubro_id, zona_nombre')
      .eq('id', trabajoId)
      .single();
    if (!trabajo) {
      throw new NotFoundException('Trabajo no encontrado');
    }
    if (trabajo.estado !== 'buscando') {
      throw new BadRequestException('Este trabajo ya no acepta postulaciones');
    }
    if (trabajo.rubro_id !== prestador.rubro_id) {
      throw new ForbiddenException('El trabajo no coincide con tu rubro');
    }

    // Insert postulacion
    const { data: postulacion, error } = await supabase
      .from('postulaciones')
      .insert({
        trabajo_id: trabajoId,
        prestador_id: prestadorId,
        monto_ofertado: dto.monto_ofertado,
        comentario: dto.comentario || null,
        estado: 'pendiente',
        created_at: new Date().toISOString(),
      })
      .select('*')
      .single();

    if (error) {
      this.logger.error(`No se pudo crear la postulación: ${error.message}`);
      throw new BadRequestException('No se pudo crear la postulación');
    }

    // Notificar al cliente
    void this.notificationsService.notifyUsers(
      [trabajo.cliente_id],
      'Nueva postulación',
      'Un prestador envió una propuesta',
      accessToken,
      { solicitudId: trabajoId, estado: trabajo.estado },
    );

    return { postulacion };
  }

  async listPostulaciones(trabajoId: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: trabajo } = await supabase
      .from('solicitudes_trabajo')
      .select('cliente_id')
      .eq('id', trabajoId)
      .single();
    if (!trabajo) {
      throw new NotFoundException('Trabajo no encontrado');
    }
    if (trabajo.cliente_id !== userId) {
      throw new ForbiddenException('Solo el cliente puede ver postulaciones');
    }

    const { data, error } = await supabase
      .from('postulaciones')
      .select('*, perfiles:perfiles!postulaciones_prestador_id_fkey(id, nombre)')
      .eq('trabajo_id', trabajoId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`No se pudieron obtener postulaciones: ${error.message}`);
      throw new BadRequestException('No se pudieron obtener las postulaciones');
    }

    return { postulaciones: data || [] };
  }

  async seleccionarPostulante(
    trabajoId: string,
    postulacionId: string,
    userId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: trabajo, error: trabajoError } = await supabase
      .from('solicitudes_trabajo')
      .select('cliente_id, estado')
      .eq('id', trabajoId)
      .single();

    if (trabajoError || !trabajo) {
      throw new NotFoundException('Trabajo no encontrado');
    }
    if (trabajo.cliente_id !== userId) {
      throw new ForbiddenException('Solo el cliente puede seleccionar postulante');
    }
    if (trabajo.estado !== 'buscando') {
      throw new BadRequestException('El trabajo ya no está en etapa de selección');
    }

    // Obtener postulacion
    const { data: postulacion } = await supabase
      .from('postulaciones')
      .select('prestador_id, estado, monto_ofertado')
      .eq('id', postulacionId)
      .eq('trabajo_id', trabajoId)
      .single();

    if (!postulacion) {
      throw new NotFoundException('Postulación no encontrada');
    }

    // Marcar postulacion ganadora y rechazar el resto
    const { error: updatePostError } = await supabase
      .from('postulaciones')
      .update({ estado: 'aceptada' })
      .eq('id', postulacionId)
      .eq('trabajo_id', trabajoId);

    if (updatePostError) {
      this.logger.error(`No se pudo aceptar la postulación: ${updatePostError.message}`);
      throw new BadRequestException('No se pudo aceptar la postulación');
    }

    await supabase
      .from('postulaciones')
      .update({ estado: 'rechazada' })
      .eq('trabajo_id', trabajoId)
      .neq('id', postulacionId);

    // Actualizar trabajo
    const { data: updated, error: workUpdateError } = await supabase
      .from('solicitudes_trabajo')
      .update({
        prestador_id: postulacion.prestador_id,
        estado: 'aceptado',
        monto: postulacion.monto_ofertado, // Update price with accepted offer
      })
      .eq('id', trabajoId)
      .select('*, rubros(id, nombre, icono)')
      .single();

    if (workUpdateError) {
      this.logger.error(`No se pudo actualizar el trabajo: ${workUpdateError.message}`);
      throw new BadRequestException('No se pudo actualizar el trabajo');
    }

    // Notificar prestador ganador
    void this.notificationsService.notifyUsers(
      [postulacion.prestador_id],
      'Fuiste seleccionado',
      'El cliente te eligió para este trabajo',
      accessToken,
      { solicitudId: trabajoId, estado: 'aceptado' },
    );

    return { solicitud: updated };
  }

  async updateStatus(
    id: string,
    userId: string,
    updateStatusDto: UpdateStatusDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Get the solicitud
      const { data: solicitud, error: fetchError } = await supabase
        .from('solicitudes_trabajo')
        .select('*, rubros(id, nombre, icono)')
        .eq('id', id)
        .single();

      if (fetchError || !solicitud) {
        throw new NotFoundException('Work request not found');
      }

      // Verify user has permission
      const isCliente = solicitud.cliente_id === userId;
      const isPrestador = solicitud.prestador_id === userId;

      if (!isCliente && !isPrestador) {
        throw new ForbiddenException('Access denied to this work request');
      }

      // Enforce who can trigger each state
      if (updateStatusDto.estado === 'aceptado') {
        throw new BadRequestException('Use /solicitudes/:id/accept to accept a job');
      }
      if (updateStatusDto.estado === 'finalizado' && !isPrestador) {
        throw new ForbiddenException('Only prestadores can finalize the work');
      }
      if (updateStatusDto.estado === 'cerrado' && !isCliente) {
        throw new ForbiddenException('Only clientes can close the work');
      }

      // Validate state transitions
      const validTransitions: Record<string, string[]> = {
        buscando: ['aceptado'],
        aceptado: ['pagado', 'finalizado'], // Can go to paid or finalized (if manual pay)
        pagado: ['finalizado'],
        finalizado: ['cerrado'],
      };

      const currentState = solicitud.estado;
      const newState = updateStatusDto.estado;

      if (
        !validTransitions[currentState] ||
        !validTransitions[currentState].includes(newState)
      ) {
        throw new BadRequestException(
          `Invalid state transition from ${currentState} to ${newState}`,
        );
      }

      // If transitioning to finalizado, ensure evidence exists
      if (newState === 'finalizado') {
        const { count, error: evError } = await supabase
          .from('evidencias')
          .select('id', { count: 'exact', head: true })
          .eq('trabajo_id', id);

        if (evError) {
          this.logger.warn(
            `Could not verify evidencias for ${id}: ${evError.message}. Proceeding without block.`,
          );
        } else if (typeof count === 'number' && count === 0) {
          throw new BadRequestException(
            'Cannot finalize work without uploading evidence first',
          );
        }
      }

      // Update status
      const { data, error } = await supabase
        .from('solicitudes_trabajo')
        .update({
          estado: newState,
        })
        .eq('id', id)
        .eq('estado', currentState)
        .select('*, rubros(id, nombre, icono), perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre)')
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          throw new ConflictException('State was updated by another process. Refresh and try again.');
        }
        this.logger.error(`Failed to update status: ${error.message}`);
        throw new BadRequestException('Failed to update status');
      }

      if (newState === 'finalizado') {
        const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
        const { error: expiresError } = await supabase
          .from('evidencias')
          .update({ expires_at: expiresAt })
          .eq('trabajo_id', id)
          .eq('es_reclamo', false);

        if (expiresError) {
          this.logger.warn(`Could not set expires_at for evidencias of ${id}: ${expiresError.message}`);
        }
      }

      // Payout Logic: When status changes to 'cerrado'
      if (newState === 'cerrado') {
        const { data: payment } = await supabase
          .from('payments')
          .select('provider_amount, status')
          .eq('solicitud_id', id)
          .eq('status', 'completed')
          .single();

        if (payment && payment.provider_amount > 0) {
          // Add to prestador balance
          const svcClient = this.supabaseService.getServiceClient();
          
          await svcClient.rpc('increment_saldo', { 
            user_id: solicitud.prestador_id, 
            amount: payment.provider_amount 
          });

          // Update payment status to released
          await svcClient
            .from('payments')
            .update({ status: 'released' })
            .eq('solicitud_id', id);

          this.logger.log(`Payout release for solicitud ${id}: ${payment.provider_amount} added to prestador ${solicitud.prestador_id}`);
        }
      }

      const targets = [solicitud.cliente_id, solicitud.prestador_id].filter(
        (uid) => uid && uid !== userId,
      );
      if (targets.length) {
        const statusCopy: Record<string, { title: string; body: string }> = {
          aceptado: {
            title: 'Solicitud aceptada',
            body: 'Un prestador tomó tu trabajo.',
          },
          pagado: {
            title: 'Pago registrado',
            body: 'El pago fue confirmado para tu solicitud.',
          },
          finalizado: {
            title: 'Trabajo finalizado',
            body: 'Revisa la evidencia y cierra la solicitud.',
          },
          cerrado: {
            title: 'Solicitud cerrada',
            body: 'El ciclo del trabajo fue cerrado.',
          },
        };

        const message = statusCopy[newState] || {
          title: 'Solicitud actualizada',
          body: `Estado: ${newState}`,
        };

        void this.notificationsService.notifyUsers(
          targets as string[],
          message.title,
          message.body,
          accessToken,
          { solicitudId: id, estado: newState },
        );
      }

      this.logger.log(`Solicitud ${id} status updated: ${currentState} -> ${newState}`);
      return { solicitud: data };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      this.logger.error(`Update status error: ${error.message}`);
      throw new BadRequestException('Failed to update status');
    }
  }

  private sanitizeLocation(solicitud: any, canSeeExact: boolean) {
    if (canSeeExact) {
      return solicitud;
    }

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
      monto: null,
      ubicacion: solicitud.zona_nombre || approxLabel || 'Ubicación a convenir',
    };
  }

  private parseCoords(value: string): { lon: number; lat: number } {
    if (!value) {
      throw new BadRequestException('Coordenadas requeridas');
    }
    const parts = value.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 2 || parts.some((p) => Number.isNaN(p))) {
      throw new BadRequestException('Formato de coordenadas inválido. Usa "lon,lat"');
    }
    const [lon, lat] = parts;
    return { lon, lat };
  }

  private parsePoint(value: any): { lon: number; lat: number } | null {
    if (!value) return null;

    // Geometry object from Postgres/PostgREST: { type: 'Point', coordinates: [lon, lat] }
    if (typeof value === 'object' && Array.isArray(value.coordinates)) {
      const [lon, lat] = value.coordinates;
      if (!Number.isNaN(lon) && !Number.isNaN(lat)) {
        return { lon: Number(lon), lat: Number(lat) };
      }
    }

    const asString = String(value);
    // Accept "POINT(lon lat)" or "(-58.38,-34.60)"
    const pointRegex = /POINT\\((-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\)/i;
    const match = asString.match(pointRegex);
    if (match) {
      return { lon: Number(match[1]), lat: Number(match[2]) };
    }
    const coordsRegex = /(-?\\d+(?:\\.\\d+)?),\\s*(-?\\d+(?:\\.\\d+)?)/;
    const m2 = asString.match(coordsRegex);
    if (m2) {
      return { lon: Number(m2[1]), lat: Number(m2[2]) };
    }
    return null;
  }
}
