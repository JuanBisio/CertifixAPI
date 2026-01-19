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

  async setVerificado(accessToken: string, prestadorId: string, value: boolean) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const { data, error } = await supabase
      .from('perfiles_prestadores')
      .update({ esta_verificado: value })
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
}
