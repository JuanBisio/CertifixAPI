import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private supabaseService: SupabaseService) {}

  async listPrestadores(accessToken: string, verificado?: boolean) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    let query = supabase.from('perfiles_prestadores').select('*');

    if (typeof verificado === 'boolean') {
      query = query.eq('esta_verificado', verificado);
    }

    const { data, error } = await query;
    if (error) {
      this.logger.error(`Failed to list prestadores: ${error.message}`);
      throw new BadRequestException('Failed to list prestadores');
    }

    return data || [];
  }

  async setVerificado(
    accessToken: string,
    prestadorId: string,
    value: boolean,
    tipoVerificacion?: 'estandar' | 'premium',
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const updateData: Record<string, any> = { esta_verificado: value };
    if (value && tipoVerificacion) {
      updateData.tipo_verificacion = tipoVerificacion;
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

  async setDisponible(accessToken: string, prestadorId: string, value: boolean) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
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
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .select('id, suscripcion_activa, suscripcion_vence_at, esta_verificado, disponible, perfiles(nombre_completo)')
      .order('suscripcion_vence_at', { ascending: true });

    if (error) {
      this.logger.error(`Failed to list suscripciones: ${error.message}`);
      throw new BadRequestException('Failed to list suscripciones');
    }

    return data || [];
  }

  async listPayments(accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
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
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
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
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    
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
