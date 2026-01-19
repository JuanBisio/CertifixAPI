import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class RubrosService {
  private readonly logger = new Logger(RubrosService.name);

  constructor(private supabaseService: SupabaseService) {}

  async findAll() {
    const supabase = this.supabaseService.getClient();

    try {
      const { data, error } = await supabase
        .from('rubros')
        .select('*')
        .order('nombre', { ascending: true });

      if (error) {
        this.logger.error(`Failed to fetch rubros: ${error.message}`);
        throw new Error('Failed to fetch rubros');
      }

      return { rubros: data || [] };
    } catch (error) {
      this.logger.error(`Find all rubros error: ${error.message}`);
      throw new Error('Failed to fetch rubros');
    }
  }

  async findOne(id: string) {
    const supabase = this.supabaseService.getClient();

    try {
      const { data, error } = await supabase
        .from('rubros')
        .select('*')
        .eq('id', id)
        .single();

      if (error) {
        this.logger.error(`Failed to fetch rubro: ${error.message}`);
        throw new NotFoundException('Rubro not found');
      }

      return { rubro: data };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error(`Find one rubro error: ${error.message}`);
      throw new NotFoundException('Rubro not found');
    }
  }
}