import { Injectable, Logger, BadRequestException, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateRatingDto } from './dto/create-rating.dto';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(private supabaseService: SupabaseService) {}

  async createRating(clienteId: string, dto: CreateRatingDto, accessToken: string) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    // Verificar que la solicitud pertenece al cliente y está cerrada
    const { data: solicitud, error: solError } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, prestador_id, estado')
      .eq('id', dto.solicitud_id)
      .single();

    if (solError || !solicitud) {
      throw new BadRequestException('Solicitud no encontrada');
    }

    if (solicitud.cliente_id !== clienteId) {
      throw new ForbiddenException('No podés calificar una solicitud que no es tuya');
    }

    if (solicitud.estado !== 'cerrado') {
      throw new BadRequestException('Solo se pueden calificar solicitudes en estado cerrado');
    }

    if (!solicitud.prestador_id) {
      throw new BadRequestException('La solicitud no tiene prestador asignado');
    }

    // Verificar que no se haya calificado antes
    const { data: existing } = await supabase
      .from('calificaciones')
      .select('id')
      .eq('solicitud_id', dto.solicitud_id)
      .single();

    if (existing) {
      throw new BadRequestException('Esta solicitud ya fue calificada');
    }

    // Insertar calificación
    const { data: rating, error: insertError } = await supabase
      .from('calificaciones')
      .insert({
        solicitud_id: dto.solicitud_id,
        prestador_id: solicitud.prestador_id,
        cliente_id: clienteId,
        puntuacion: dto.puntaje,
        comentario: dto.comentario ?? null,
      })
      .select()
      .single();

    if (insertError) {
      this.logger.error(`Error insertando calificación: ${insertError.message}`);
      throw new BadRequestException('Error guardando la calificación');
    }

    // Recalcular rating del prestador vía RPC
    const serviceSupabase = this.supabaseService.getServiceClient();
    await serviceSupabase.rpc('recalcular_rating_prestador', {
      p_prestador_id: solicitud.prestador_id,
    });

    this.logger.log(
      `Calificación creada: solicitud=${dto.solicitud_id} prestador=${solicitud.prestador_id} puntaje=${dto.puntaje}`,
    );

    return { rating };
  }

  async getRatingsPrestador(prestadorId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('calificaciones')
      .select('puntuacion, comentario, created_at, clientes:cliente_id(nombre)')
      .eq('prestador_id', prestadorId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Error obteniendo ratings: ${error.message}`);
      throw new BadRequestException('Error obteniendo calificaciones');
    }

    return { ratings: data ?? [] };
  }
}
