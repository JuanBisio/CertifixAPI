import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateDisputaDto } from './dto/create-disputa.dto';

@Injectable()
export class DisputasService {
  private readonly logger = new Logger(DisputasService.name);

  constructor(private supabaseService: SupabaseService) {}

  async create(
    userId: string,
    createDisputaDto: CreateDisputaDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Verify trabajo exists and user has access
      const { data: trabajo, error: trabajoError } = await supabase
        .from('solicitudes_trabajo')
        .select('cliente_id, prestador_id')
        .eq('id', createDisputaDto.trabajo_id)
        .single();

      if (trabajoError || !trabajo) {
        throw new BadRequestException('Work request not found');
      }

      if (trabajo.cliente_id !== userId && trabajo.prestador_id !== userId) {
        throw new ForbiddenException('Access denied to this work request');
      }

      // Check if dispute already exists
      const { data: existing } = await supabase
        .from('disputas')
        .select('id')
        .eq('trabajo_id', createDisputaDto.trabajo_id)
        .single();

      if (existing) {
        throw new ConflictException('Dispute already exists for this work request');
      }

      // Create dispute
      const { data, error } = await supabase
        .from('disputas')
        .insert({
          trabajo_id: createDisputaDto.trabajo_id,
          razon: createDisputaDto.razon,
          estado_disputa: 'pendiente',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        this.logger.error(`Failed to create dispute: ${error.message}`);
        throw new BadRequestException('Failed to create dispute');
      }

      this.logger.log(`Dispute created for trabajo: ${createDisputaDto.trabajo_id}`);
      return { disputa: data };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      this.logger.error(`Create dispute error: ${error.message}`);
      throw new BadRequestException('Failed to create dispute');
    }
  }

  async findByTrabajo(
    trabajoId: string,
    userId: string,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    try {
      // Verify user has access to this trabajo
      const { data: trabajo, error: trabajoError } = await supabase
        .from('solicitudes_trabajo')
        .select('cliente_id, prestador_id')
        .eq('id', trabajoId)
        .single();

      if (trabajoError || !trabajo) {
        throw new BadRequestException('Work request not found');
      }

      if (trabajo.cliente_id !== userId && trabajo.prestador_id !== userId) {
        throw new ForbiddenException('Access denied to this work request');
      }

      // Get dispute
      const { data, error } = await supabase
        .from('disputas')
        .select('*')
        .eq('trabajo_id', trabajoId)
        .single();

      if (error && error.code !== 'PGRST116') {
        this.logger.error(`Failed to fetch dispute: ${error.message}`);
        throw new BadRequestException('Failed to fetch dispute');
      }

      return { disputa: data || null };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }
      this.logger.error(`Find dispute error: ${error.message}`);
      throw new BadRequestException('Failed to fetch dispute');
    }
  }
}