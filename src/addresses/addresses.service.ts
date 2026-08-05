import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

const MAX_DIRECCIONES_GUARDADAS = 20;

@Injectable()
export class AddressesService {
  private readonly logger = new Logger(AddressesService.name);

  constructor(private supabaseService: SupabaseService) {}

  async create(userId: string, dto: CreateAddressDto, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { count } = await supabase
      .from('direcciones_guardadas')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_active', true);

    if ((count ?? 0) >= MAX_DIRECCIONES_GUARDADAS) {
      throw new BadRequestException(
        `Alcanzaste el máximo de ${MAX_DIRECCIONES_GUARDADAS} direcciones guardadas`,
      );
    }

    const shouldBeDefault = dto.is_default ?? (count ?? 0) === 0;
    if (shouldBeDefault) {
      await supabase
        .from('direcciones_guardadas')
        .update({ is_default: false })
        .eq('user_id', userId);
    }

    const { data, error } = await supabase
      .from('direcciones_guardadas')
      .insert({ user_id: userId, ...dto, is_default: shouldBeDefault })
      .select()
      .single();

    if (error) {
      this.logger.error(`Error creando dirección: ${error.message}`);
      throw new BadRequestException('No se pudo guardar la dirección');
    }
    return { direccion: data };
  }

  async findAll(userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    const { data, error } = await supabase
      .from('direcciones_guardadas')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException('Error obteniendo direcciones');
    return { direcciones: data ?? [] };
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateAddressDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    if (dto.is_default) {
      await supabase
        .from('direcciones_guardadas')
        .update({ is_default: false })
        .eq('user_id', userId);
    }

    const { data, error } = await supabase
      .from('direcciones_guardadas')
      .update(dto)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Dirección no encontrada');
    return { direccion: data };
  }

  async setDefault(id: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);
    await supabase
      .from('direcciones_guardadas')
      .update({ is_default: false })
      .eq('user_id', userId);

    const { data, error } = await supabase
      .from('direcciones_guardadas')
      .update({ is_default: true })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('is_active', true)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Dirección no encontrada');
    return { direccion: data };
  }

  async remove(id: string, userId: string, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: existing } = await supabase
      .from('direcciones_guardadas')
      .select('id, is_default')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!existing) throw new NotFoundException('Dirección no encontrada');

    const { error } = await supabase
      .from('direcciones_guardadas')
      .update({ is_active: false, is_default: false })
      .eq('id', id)
      .eq('user_id', userId);

    if (error)
      throw new BadRequestException('No se pudo eliminar la dirección');

    if (existing.is_default) {
      const { data: next } = await supabase
        .from('direcciones_guardadas')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (next) {
        await supabase
          .from('direcciones_guardadas')
          .update({ is_default: true })
          .eq('id', next.id);
      }
    }

    return { success: true };
  }
}
