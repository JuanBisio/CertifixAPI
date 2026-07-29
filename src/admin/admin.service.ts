import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfilesService } from '../profiles/profiles.service';
import { EvidenciasService } from '../evidencias/evidencias.service';
import { ListSolicitudesQuery } from './dto/list-solicitudes.dto';
import {
  SubscriptionsService,
  TRABAJOS_GRATIS_LIMITE,
  SUBSCRIPTION_AMOUNT,
  SUBSCRIPTION_PERIOD_DAYS,
} from '../subscriptions/subscriptions.service';

const ESTADOS_SOLICITUD = ['buscando', 'aceptado', 'en_camino', 'en_trabajo', 'finalizado', 'cerrado', 'cancelado'] as const;

// Documentos de identidad: sólo se exponen vía GET /admin/prestadores/:id/documentos
// (signed URLs, TTL corto) — no en el listado general, para minimizar exposición.
const SENSITIVE_DOC_COLUMNS = [
  'dni_frente_url',
  'dni_dorso_url',
  'selfie_dni_url',
  'matricula_url',
] as const;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private supabaseService: SupabaseService,
    private profilesService: ProfilesService,
    private evidenciasService: EvidenciasService,
    private subscriptionsService: SubscriptionsService,
  ) {}

  async getMetrics() {
    const supabase = this.supabaseService.getServiceClient();
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const startOfNextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    const hace30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [trabajosPorEstado, prestadores, pagosDelMes, cancelados30d, total30d, disputasAbiertas] = await Promise.all([
      Promise.all(
        ESTADOS_SOLICITUD.map(async (estado) => ({
          estado,
          count:
            (
              await supabase
                .from('solicitudes_trabajo')
                .select('id', { count: 'exact', head: true })
                .eq('estado', estado)
            ).count ?? 0,
        })),
      ),
      supabase
        .from('perfiles_prestadores')
        .select('esta_verificado, verificacion_rechazada_at, cuenta_baja_at, suscripcion_activa, suscripcion_vence_at, trabajos_gratis_usados'),
      supabase
        .from('suscripcion_pagos')
        .select('amount')
        .eq('status', 'completed')
        .gte('created_at', startOfMonth)
        .lt('created_at', startOfNextMonth),
      supabase
        .from('solicitudes_trabajo')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'cancelado')
        .gte('created_at', hace30d),
      supabase.from('solicitudes_trabajo').select('id', { count: 'exact', head: true }).gte('created_at', hace30d),
      supabase.from('disputas').select('id', { count: 'exact', head: true }).eq('estado', 'abierta'),
    ]);

    const prestadoresRows = prestadores.data ?? [];
    const prestadoresPorVerificacion = { pendiente: 0, verificado: 0, rechazado: 0, baja: 0 };
    const suscripciones = { activa: 0, proxima_a_vencer: 0, vencida: 0, promo_gratis: 0 };

    for (const row of prestadoresRows as any[]) {
      if (row.cuenta_baja_at) {
        prestadoresPorVerificacion.baja += 1;
      } else if (row.esta_verificado) {
        prestadoresPorVerificacion.verificado += 1;
      } else if (row.verificacion_rechazada_at) {
        prestadoresPorVerificacion.rechazado += 1;
      } else {
        prestadoresPorVerificacion.pendiente += 1;
      }

      const trabajosGratisRestantes = Math.max(TRABAJOS_GRATIS_LIMITE - (row.trabajos_gratis_usados ?? 0), 0);
      if (!row.suscripcion_activa) {
        if (trabajosGratisRestantes > 0) suscripciones.promo_gratis += 1;
        else suscripciones.vencida += 1;
      } else {
        const diasRestantes = row.suscripcion_vence_at
          ? (new Date(row.suscripcion_vence_at).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
          : Infinity;
        if (diasRestantes <= 3) suscripciones.proxima_a_vencer += 1;
        else suscripciones.activa += 1;
      }
    }

    const ingresosMesActual = (pagosDelMes.data ?? []).reduce((sum: number, p: any) => sum + (p.amount ?? 0), 0);

    return {
      trabajos_por_estado: trabajosPorEstado,
      prestadores_por_verificacion: prestadoresPorVerificacion,
      suscripciones,
      ingresos_mes_actual: ingresosMesActual,
      tasa_cancelacion: {
        tasa: total30d.count ? ((cancelados30d.count ?? 0) / total30d.count) * 100 : 0,
        muestra: total30d.count ?? 0,
      },
      disputas_abiertas: disputasAbiertas.count ?? 0,
    };
  }

  async listPrestadores(accessToken: string, verificado?: boolean) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    let query = supabase.from('perfiles_prestadores').select('*, perfiles(nombre)');

    if (typeof verificado === 'boolean') {
      query = query.eq('esta_verificado', verificado);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error(`Failed to list prestadores: ${error.message}`);
      throw new BadRequestException('Failed to list prestadores');
    }

    return (data || []).map((row: Record<string, any>) => {
      const { ...rest } = row;
      SENSITIVE_DOC_COLUMNS.forEach((col) => delete rest[col]);
      return rest;
    });
  }

  async getDocumentosPrestador(prestadorId: string) {
    return this.profilesService.getDocumentosPrestador(prestadorId);
  }

  async getHistorialPrestador(prestadorId: string) {
    const supabase = this.supabaseService.getServiceClient();
    const [{ data: perfil }, { data: pp }, { data: strikes }, { data: calificaciones }] = await Promise.all([
      supabase.from('perfiles').select('strikes_count, suspendido').eq('id', prestadorId).single(),
      supabase.from('perfiles_prestadores').select('rating, trabajos_completados').eq('id', prestadorId).single(),
      supabase.from('strikes_historial').select('*').eq('perfil_id', prestadorId).order('created_at', { ascending: false }),
      supabase.from('calificaciones').select('*').eq('prestador_id', prestadorId).order('created_at', { ascending: false }),
    ]);

    const avg = (key: string) => {
      const vals = (calificaciones ?? []).map((c: any) => c[key]).filter((v: any) => v != null);
      return vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null;
    };

    return {
      strikes_count: perfil?.strikes_count ?? 0,
      suspendido: perfil?.suspendido ?? false,
      strikes: strikes ?? [],
      calificaciones: {
        promedio: pp?.rating ?? null,
        trabajos_completados: pp?.trabajos_completados ?? 0,
        promedio_subcategorias: {
          comunicacion: avg('comunicacion'),
          puntualidad: avg('puntualidad'),
          atencion: avg('atencion'),
          eficiencia: avg('eficiencia'),
        },
        recientes: (calificaciones ?? []).slice(0, 10),
      },
    };
  }

  async setVerificado(
    accessToken: string,
    prestadorId: string,
    value: boolean,
    tipoVerificacion?: 'estandar' | 'premium',
  ) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const updateData: Record<string, any> = { esta_verificado: value };
    if (value && tipoVerificacion) {
      updateData.tipo_verificacion = tipoVerificacion;
    }
    // Si se aprueba a un prestador previamente rechazado, limpiar el timestamp
    // de rechazo — evita dejar un dato inconsistente (rechazado + verificado).
    if (value) {
      updateData.verificacion_rechazada_at = null;
    }

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update(updateData)
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to update verification: ${error.message}`);
      throw new BadRequestException('Failed to update verification');
    }

    return data;
  }

  async rejectPrestador(accessToken: string, prestadorId: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const { data: actual } = await supabase
      .from('perfiles_prestadores')
      .select('esta_verificado')
      .eq('id', prestadorId)
      .single();

    if (actual?.esta_verificado) {
      throw new BadRequestException(
        'No se puede rechazar un prestador ya verificado — usar dar de baja',
      );
    }

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ esta_verificado: false, verificacion_rechazada_at: new Date().toISOString() })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to reject prestador: ${error.message}`);
      throw new BadRequestException('Failed to reject prestador');
    }

    return data;
  }

  async darDeBajaPrestador(prestadorId: string, confirmarConTrabajoActivo: boolean) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    if (!confirmarConTrabajoActivo) {
      const { data: trabajoActivo } = await supabase
        .from('solicitudes_trabajo')
        .select('id, estado, created_at, cliente:perfiles!solicitudes_trabajo_cliente_id_fkey(nombre)')
        .eq('prestador_id', prestadorId)
        .in('estado', ['aceptado', 'en_camino', 'en_trabajo'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (trabajoActivo) {
        throw new ConflictException({
          message: 'El prestador tiene un trabajo activo en curso',
          trabajo_activo: trabajoActivo,
        });
      }
    }

    const { data: prestador } = await supabase
      .from('perfiles_prestadores')
      .select('mp_preapproval_id')
      .eq('id', prestadorId)
      .single();

    let suscripcionCancelada = false;
    if (prestador?.mp_preapproval_id) {
      try {
        await this.subscriptionsService.cancel(prestadorId);
        suscripcionCancelada = true;
      } catch (err: any) {
        // No bloquear la baja por una falla de MercadoPago: priorizar sacar al
        // prestador de circulación. El admin ve mp_cancelacion_ok=false y cancela
        // manualmente en el dashboard de MP si hace falta.
        this.logger.error(`No se pudo cancelar la suscripción MP al dar de baja: ${err.message}`);
      }
    }

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({
        cuenta_baja_at: new Date().toISOString(),
        disponible: false,
        esta_verificado: false,
        suscripcion_activa: false,
      })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to dar de baja prestador: ${error.message}`);
      throw new BadRequestException('Failed to dar de baja prestador');
    }

    return { ...data, mp_cancelacion_ok: suscripcionCancelada };
  }

  async setDisponible(accessToken: string, prestadorId: string, value: boolean) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ disponible: value })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to update disponibilidad: ${error.message}`);
      throw new BadRequestException('Failed to update disponibilidad');
    }

    return data;
  }

  async listSuscripciones(accessToken: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .select('id, suscripcion_activa, suscripcion_vence_at, esta_verificado, disponible, trabajos_gratis_usados, perfiles(nombre)')
      .order('suscripcion_vence_at', { ascending: true });

    if (error) {
      this.logger.error(`Failed to list suscripciones: ${error.message}`);
      throw new BadRequestException('Failed to list suscripciones');
    }

    return data || [];
  }

  // Reusa tal cual SubscriptionsService.getHistory (ya expone exactamente esta forma vía
  // GET /subscriptions/history para el propio prestador) — mismo método, distinto guard de acceso.
  async getPagosPrestador(prestadorId: string) {
    return this.subscriptionsService.getHistory(prestadorId);
  }

  async extenderSuscripcion(prestadorId: string, dias: number) {
    const supabase = this.supabaseService.getServiceClient();
    const { data: prestador, error: fetchError } = await supabase
      .from('perfiles_prestadores')
      .select('suscripcion_vence_at')
      .eq('id', prestadorId)
      .single();

    if (fetchError || !prestador) {
      throw new NotFoundException('Prestador no encontrado');
    }

    // Si ya venció, extender desde hoy; si sigue vigente, sumar sobre el vencimiento actual
    // (no perder el resto del período ya vigente).
    const base =
      prestador.suscripcion_vence_at && new Date(prestador.suscripcion_vence_at) > new Date()
        ? new Date(prestador.suscripcion_vence_at)
        : new Date();
    const nuevaFecha = new Date(base.getTime() + dias * 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ suscripcion_vence_at: nuevaFecha.toISOString(), suscripcion_activa: true })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to extender suscripcion: ${error.message}`);
      throw new BadRequestException('No se pudo extender la suscripción');
    }

    return data;
  }

  async registrarPagoOffline(
    prestadorId: string,
    dto: { metodo: string; monto?: number; dias?: number; nota?: string },
    adminEmail?: string,
  ) {
    const supabase = this.supabaseService.getServiceClient();
    const monto = dto.monto ?? SUBSCRIPTION_AMOUNT;
    const dias = dto.dias ?? SUBSCRIPTION_PERIOD_DAYS;
    const periodStart = new Date();
    const periodEnd = new Date(periodStart.getTime() + dias * 24 * 60 * 60 * 1000);

    const { error: payError } = await supabase.from('suscripcion_pagos').insert({
      prestador_id: prestadorId,
      amount: monto,
      status: 'completed',
      payment_method: dto.metodo,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      registrado_por_admin_email: adminEmail ?? null,
      nota_admin: dto.nota ?? null,
    });

    if (payError) {
      this.logger.error(`Failed to registrar pago offline: ${payError.message}`);
      throw new BadRequestException('No se pudo registrar el pago');
    }

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ suscripcion_activa: true, suscripcion_vence_at: periodEnd.toISOString() })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to activar suscripcion tras pago offline: ${error.message}`);
      throw new BadRequestException('Pago registrado pero no se pudo activar la suscripción');
    }

    return data;
  }

  async listDisputas(accessToken: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('disputas')
      .select(
        '*, trabajo:solicitudes_trabajo(id, rubros(id, nombre, icono), cliente:perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), prestador:perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre))',
      )
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to list disputas: ${error.message}`);
      throw new BadRequestException('Failed to list disputas');
    }

    return data || [];
  }

  async getDisputaDetail(disputaId: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const { data: disputa, error } = await supabase
      .from('disputas')
      .select('*')
      .eq('id', disputaId)
      .single();

    if (error || !disputa) {
      throw new NotFoundException('Disputa no encontrada');
    }

    const { data: trabajo } = await supabase
      .from('solicitudes_trabajo')
      .select(
        '*, rubros(id, nombre, icono), cliente:perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), prestador:perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre)',
      )
      .eq('id', disputa.trabajo_id)
      .maybeSingle();

    const evidencias = trabajo
      ? await this.evidenciasService.getEvidenciasConUrlsByTrabajo(trabajo.id)
      : [];

    return { disputa, trabajo, evidencias };
  }

  async resolveDisputa(disputaId: string, resolution: string, nota: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const newEstado = resolution === 'a_favor_cliente'
      ? 'resuelta_a_favor_cliente'
      : 'resuelta_a_favor_prestador';
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from('disputas')
      .update({ estado: newEstado, nota_resolucion: nota, resolved_at: nowIso, updated_at: nowIso })
      .eq('id', disputaId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to resolve disputa: ${error.message}`);
      throw new BadRequestException('Failed to resolve disputa');
    }

    return data;
  }

  async reopenDisputa(disputaId: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('disputas')
      .update({ estado: 'abierta', updated_at: new Date().toISOString() })
      .eq('id', disputaId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to reopen disputa: ${error.message}`);
      throw new BadRequestException('Failed to reopen disputa');
    }

    return data;
  }

  // NO reusa SolicitudesService.findAll a propósito: está atado estructuralmente a
  // getAuthenticatedClient(accessToken) + filtro obligatorio por cliente_id/prestador_id
  // (queries RLS-owned). Acá se replica el mismo patrón de select con alias de FK que ya
  // usa solicitudes.service.ts, con bypass explícito vía service_role (sin ownership),
  // mismo criterio arquitectónico que el resto de este service.
  async listSolicitudes(query: ListSolicitudesQuery) {
    const supabase = this.supabaseService.getServiceClient();
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const from = (page - 1) * limit;

    let q = supabase
      .from('solicitudes_trabajo')
      .select(
        '*, rubros(id, nombre, icono), cliente:perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), prestador:perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre)',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (query.estado) q = q.eq('estado', query.estado);
    if (query.rubro_id) q = q.eq('rubro_id', query.rubro_id);
    if (query.desde) q = q.gte('created_at', query.desde);
    if (query.hasta) q = q.lte('created_at', query.hasta);

    const { data, error, count } = await q;
    if (error) {
      this.logger.error(`Failed to list solicitudes: ${error.message}`);
      throw new BadRequestException('Error obteniendo solicitudes');
    }

    return { data: data ?? [], page, limit, total: count ?? 0 };
  }

  async getSolicitudDetail(id: string) {
    const supabase = this.supabaseService.getServiceClient();
    const { data: solicitud, error } = await supabase
      .from('solicitudes_trabajo')
      .select(
        '*, rubros(id, nombre, icono), cliente:perfiles!solicitudes_trabajo_cliente_id_fkey(id, nombre), prestador:perfiles!solicitudes_trabajo_prestador_id_fkey(id, nombre)',
      )
      .eq('id', id)
      .single();

    if (error || !solicitud) {
      throw new NotFoundException('Solicitud no encontrada');
    }

    const { data: mensajes } = await supabase
      .from('mensajes')
      .select('*')
      .eq('solicitud_id', id)
      .order('created_at', { ascending: true });

    const evidencias = await this.evidenciasService.getEvidenciasConUrlsByTrabajo(id);

    return { solicitud, mensajes: mensajes ?? [], evidencias };
  }
}
