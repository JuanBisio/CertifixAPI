import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateRubroDto } from './dto/create-rubro.dto';
import { UpdateRubroDto } from './dto/update-rubro.dto';
import { randomUUID } from 'crypto';

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

  // ─── RQ-02: ABM de rubros (admin) ──────────────────────────────────────────
  // service_role (bypass RLS) — mismo criterio que el resto de src/admin/: el
  // guard ya verificó que el caller es admin, no depende de policies RLS.

  async create(dto: CreateRubroDto) {
    const supabase = this.supabaseService.getServiceClient();

    // `rubros.id` es TEXT sin default en la DB (los rubros existentes usan ids
    // simples tipo "1"/"2", asignados a mano) — para altas nuevas generamos un
    // uuid random, evita colisiones sin depender de un slug del nombre.
    const { data, error } = await supabase
      .from('rubros')
      .insert({ id: randomUUID(), nombre: dto.nombre, icono: dto.icono ?? null })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create rubro: ${error.message}`);
      throw new BadRequestException('Failed to create rubro');
    }

    this.logger.log(`Rubro creado: ${data.id} (${data.nombre})`);
    return { rubro: data };
  }

  async update(id: string, dto: UpdateRubroDto) {
    const supabase = this.supabaseService.getServiceClient();

    const updateData: Record<string, any> = {};
    if (dto.nombre !== undefined) updateData.nombre = dto.nombre;
    if (dto.icono !== undefined) updateData.icono = dto.icono;

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('No hay campos para actualizar');
    }

    const { data, error } = await supabase
      .from('rubros')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      this.logger.error(`Failed to update rubro ${id}: ${error?.message}`);
      throw new NotFoundException('Rubro not found');
    }

    this.logger.log(`Rubro actualizado: ${id}`);
    return { rubro: data };
  }

  async remove(id: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { error } = await supabase.from('rubros').delete().eq('id', id);

    if (error) {
      // 23503 = violación de FK — el rubro todavía está en uso (solicitudes o
      // prestador_rubros lo referencian, sin ON DELETE CASCADE configurado).
      if (error.code === '23503') {
        throw new BadRequestException(
          'No se puede borrar: hay solicitudes o prestadores usando este rubro',
        );
      }
      this.logger.error(`Failed to delete rubro ${id}: ${error.message}`);
      throw new BadRequestException('Failed to delete rubro');
    }

    this.logger.log(`Rubro eliminado: ${id}`);
    return { success: true };
  }
}