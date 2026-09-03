import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateRevocacionDto } from './dto/create-revocacion.dto';
import type { User, SupabaseClient } from '@supabase/supabase-js';

const VENTANA_DIAS = 10;
const VENTANA_MS = VENTANA_DIAS * 24 * 60 * 60 * 1000;

interface Contratacion {
  fecha_contratacion: string | null;
  tipo_revocado: string;
  sin_cobro?: boolean;
}

@Injectable()
export class RevocacionesService {
  private readonly logger = new Logger(RevocacionesService.name);

  constructor(
    private supabaseService: SupabaseService,
    private notificationsService: NotificationsService,
  ) {}

  // El ancla temporal de la ventana de arrepentimiento depende del rol:
  // cliente → fecha de alta de cuenta; prestador → cobro efectivo más
  // reciente de la suscripción (cada pago mensual es una nueva
  // contratación y renueva la ventana de 10 días para ese cobro).
  private async derivarContratacion(
    supabase: SupabaseClient,
    userId: string,
    rol: string,
  ): Promise<Contratacion> {
    if (rol === 'prestador') {
      const { data: ultimoPago } = await supabase
        .from('suscripcion_pagos')
        .select('created_at')
        .eq('prestador_id', userId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!ultimoPago) {
        return {
          fecha_contratacion: null,
          tipo_revocado: 'La suscripción paga a CertiFix',
          sin_cobro: true,
        };
      }

      return {
        fecha_contratacion: ultimoPago.created_at,
        tipo_revocado: 'La suscripción paga a CertiFix',
      };
    }

    const { data: perfil, error } = await supabase
      .from('perfiles')
      .select('created_at')
      .eq('id', userId)
      .single();

    if (error || !perfil) {
      throw new NotFoundException('Perfil no encontrado');
    }

    return {
      fecha_contratacion: perfil.created_at,
      tipo_revocado: 'El uso del servicio de intermediación de CertiFix',
    };
  }

  async getElegibilidad(user: User, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: perfil, error } = await supabase
      .from('perfiles')
      .select('rol, nombre')
      .eq('id', user.id)
      .single();

    if (error || !perfil) {
      throw new NotFoundException('Perfil no encontrado');
    }

    if (perfil.rol !== 'cliente' && perfil.rol !== 'prestador') {
      throw new BadRequestException(
        'El perfil todavía no tiene un rol asignado',
      );
    }

    const contratacion = await this.derivarContratacion(
      supabase,
      user.id,
      perfil.rol,
    );
    const dentroDeVentana = this.estaDentroDeVentana(
      contratacion.fecha_contratacion,
    );

    const { data: solicitudExistente } = await supabase
      .from('solicitudes_revocacion')
      .select('id, created_at, procesado')
      .eq('perfil_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      rol: perfil.rol,
      nombre: perfil.nombre,
      dato_cuenta: user.email ?? null,
      tipo_revocado: contratacion.tipo_revocado,
      fecha_contratacion: contratacion.fecha_contratacion,
      dentro_de_ventana: dentroDeVentana,
      dias_restantes: this.diasRestantes(contratacion.fecha_contratacion),
      sin_cobro: contratacion.sin_cobro ?? false,
      ya_solicitado: !!solicitudExistente,
      solicitud_existente: solicitudExistente ?? null,
    };
  }

  async crear(user: User, accessToken: string, dto: CreateRevocacionDto) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: perfil, error } = await supabase
      .from('perfiles')
      .select('rol, nombre')
      .eq('id', user.id)
      .single();

    if (error || !perfil) {
      throw new NotFoundException('Perfil no encontrado');
    }

    if (perfil.rol !== 'cliente' && perfil.rol !== 'prestador') {
      throw new BadRequestException(
        'El perfil todavía no tiene un rol asignado',
      );
    }

    const { data: existente } = await supabase
      .from('solicitudes_revocacion')
      .select('id')
      .eq('perfil_id', user.id)
      .limit(1)
      .maybeSingle();

    if (existente) {
      throw new ConflictException(
        'Ya existe una solicitud de arrepentimiento para esta cuenta',
      );
    }

    // Se vuelve a derivar la ventana server-side — nunca confiamos en el
    // estado que trae el cliente móvil (pudo quedar viejo en pantalla).
    const contratacion = await this.derivarContratacion(
      supabase,
      user.id,
      perfil.rol,
    );

    if (!this.estaDentroDeVentana(contratacion.fecha_contratacion)) {
      throw new ForbiddenException(
        'La ventana de arrepentimiento de 10 días corridos venció',
      );
    }

    const { data, error: insertError } = await supabase
      .from('solicitudes_revocacion')
      .insert({
        perfil_id: user.id,
        rol: perfil.rol,
        nombre: perfil.nombre,
        dato_cuenta: user.email ?? '',
        tipo_revocado: contratacion.tipo_revocado,
        fecha_contratacion: contratacion.fecha_contratacion,
        motivo: dto.motivo ?? null,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      this.logger.error(
        `Failed to create solicitud de revocación: ${insertError.message}`,
      );
      throw new BadRequestException(
        'No se pudo registrar la solicitud de arrepentimiento',
      );
    }

    // Confirmación in-app al usuario — no hay servicio de email en el
    // backend hoy, así que reusamos el push de Expo ya integrado.
    await this.notificationsService.notifyUsers(
      [user.id],
      'Solicitud de arrepentimiento recibida',
      'Recibimos tu solicitud. El equipo de CertiFix la va a procesar en los próximos días.',
      accessToken,
    );

    this.logger.log(`Solicitud de revocación creada para perfil ${user.id}`);
    return { solicitud: data };
  }

  private estaDentroDeVentana(fechaContratacion: string | null): boolean {
    if (!fechaContratacion) return false;
    return Date.now() - new Date(fechaContratacion).getTime() <= VENTANA_MS;
  }

  private diasRestantes(fechaContratacion: string | null): number {
    if (!fechaContratacion) return 0;
    const transcurridoMs = Date.now() - new Date(fechaContratacion).getTime();
    const restanteMs = VENTANA_MS - transcurridoMs;
    return Math.max(Math.ceil(restanteMs / (24 * 60 * 60 * 1000)), 0);
  }
}
