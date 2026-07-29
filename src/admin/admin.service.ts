import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ProfilesService } from '../profiles/profiles.service';

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
  ) {}

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

  async darDeBajaPrestador(accessToken: string, prestadorId: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ cuenta_baja_at: new Date().toISOString(), disponible: false })
      .eq('id', prestadorId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to dar de baja prestador: ${error.message}`);
      throw new BadRequestException('Failed to dar de baja prestador');
    }

    return data;
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

  async listPayments(accessToken: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to list payments: ${error.message}`);
      throw new BadRequestException('Failed to list payments');
    }

    return data || [];
  }

  async listDisputas(accessToken: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    const { data, error } = await supabase
      .from('disputas')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to list disputas: ${error.message}`);
      throw new BadRequestException('Failed to list disputas');
    }

    return data || [];
  }

  async resolveDisputa(accessToken: string, disputaId: string, resolution: string) {
    // AdminGuard ya verificó en TypeScript que el caller es admin — usamos
    // service_role a propósito para no depender de que las policies RLS
    // repliquen ese mismo chequeo (hoy vive en app_metadata/allowlist de env,
    // no en una columna de la base).
    const supabase = this.supabaseService.getServiceClient();
    
    const newEstado = resolution === 'a_favor_cliente' 
      ? 'resuelta_a_favor_cliente' 
      : 'resuelta_a_favor_prestador';

    const { data, error } = await supabase
      .from('disputas')
      .update({ estado: newEstado, updated_at: new Date().toISOString() })
      .eq('id', disputaId)
      .select('*')
      .single();

    if (error) {
      this.logger.error(`Failed to resolve disputa: ${error.message}`);
      throw new BadRequestException('Failed to resolve disputa');
    }

    return data;
  }
}
