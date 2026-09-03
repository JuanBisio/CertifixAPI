import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateRatingDto } from './dto/create-rating.dto';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(private supabaseService: SupabaseService) {}

  async createRating(
    clienteId: string,
    dto: CreateRatingDto,
    accessToken: string,
  ) {
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
      throw new ForbiddenException(
        'No podés calificar una solicitud que no es tuya',
      );
    }

    if (solicitud.estado !== 'cerrado') {
      throw new BadRequestException(
        'Solo se pueden calificar solicitudes en estado cerrado',
      );
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

    // Insertar calificación (comunicacion/puntualidad/atencion/eficiencia son opcionales — CAL-02)
    const { data: rating, error: insertError } = await supabase
      .from('calificaciones')
      .insert({
        solicitud_id: dto.solicitud_id,
        prestador_id: solicitud.prestador_id,
        cliente_id: clienteId,
        puntuacion: dto.puntaje,
        comentario: dto.comentario ?? null,
        comunicacion: dto.comunicacion ?? null,
        puntualidad: dto.puntualidad ?? null,
        atencion: dto.atencion ?? null,
        eficiencia: dto.eficiencia ?? null,
      })
      .select()
      .single();

    if (insertError) {
      this.logger.error(
        `Error insertando calificación: ${insertError.message}`,
      );
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

  async createRatingCliente(
    prestadorId: string,
    dto: CreateRatingDto,
    accessToken: string,
  ) {
    const supabase = this.supabaseService.getAuthenticatedClient(accessToken);

    const { data: solicitud, error: solError } = await supabase
      .from('solicitudes_trabajo')
      .select('id, cliente_id, prestador_id, estado')
      .eq('id', dto.solicitud_id)
      .single();

    if (solError || !solicitud) {
      throw new BadRequestException('Solicitud no encontrada');
    }

    if (solicitud.prestador_id !== prestadorId) {
      throw new ForbiddenException(
        'No podés calificar una solicitud que no es tuya',
      );
    }

    if (!['finalizado', 'cerrado'].includes(solicitud.estado)) {
      throw new BadRequestException(
        'Solo se puede calificar al cliente en estado finalizado o cerrado',
      );
    }

    const { data: existing } = await supabase
      .from('calificaciones_cliente')
      .select('id')
      .eq('solicitud_id', dto.solicitud_id)
      .single();

    if (existing) {
      throw new BadRequestException(
        'Ya calificaste al cliente de esta solicitud',
      );
    }

    const { data: rating, error: insertError } = await supabase
      .from('calificaciones_cliente')
      .insert({
        solicitud_id: dto.solicitud_id,
        prestador_id: prestadorId,
        cliente_id: solicitud.cliente_id,
        puntuacion: dto.puntaje,
        comentario: dto.comentario ?? null,
      })
      .select()
      .single();

    if (insertError) {
      this.logger.error(
        `Error insertando calificación de cliente: ${insertError.message}`,
      );
      throw new BadRequestException('Error guardando la calificación');
    }

    this.logger.log(
      `Calificación de cliente creada: solicitud=${dto.solicitud_id} cliente=${solicitud.cliente_id} puntaje=${dto.puntaje}`,
    );

    return { rating };
  }

  async getRatingsPrestador(prestadorId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('calificaciones')
      .select(
        'id, solicitud_id, puntuacion, comentario, created_at, comunicacion, puntualidad, atencion, eficiencia, clientes:cliente_id(nombre)',
      )
      .eq('prestador_id', prestadorId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Error obteniendo ratings: ${error.message}`);
      throw new BadRequestException('Error obteniendo calificaciones');
    }

    // CAL-04: reseña cruzada ciega — una calificación queda oculta del
    // listado público hasta que ambas partes calificaron esa misma
    // solicitud, para que quien todavía no calificó no vea antes la reseña
    // ajena y la use para condicionar la propia.
    const ratings = await this.filtrarPorResenaCruzadaCompleta(
      supabase,
      data ?? [],
      'calificaciones_cliente',
    );

    // CAL-02: promedio por subcategoría, solo entre las reseñas que la completaron (son opcionales)
    const promedio = (values: Array<number | null | undefined>) => {
      const validos = values.filter((v): v is number => v != null);
      if (!validos.length) return null;
      return (
        Math.round(
          (validos.reduce((sum, v) => sum + v, 0) / validos.length) * 100,
        ) / 100
      );
    };

    const promedios = {
      comunicacion: promedio(ratings.map((r: any) => r.comunicacion)),
      puntualidad: promedio(ratings.map((r: any) => r.puntualidad)),
      atencion: promedio(ratings.map((r: any) => r.atencion)),
      eficiencia: promedio(ratings.map((r: any) => r.eficiencia)),
    };

    return { ratings, promedios };
  }

  // RQ-04: reputación del cliente — calificaciones que le dejaron los prestadores
  // (calificaciones_cliente, sin subcategorías, solo puntuacion/comentario).
  async getRatingsCliente(clienteId: string) {
    const supabase = this.supabaseService.getServiceClient();

    const { data, error } = await supabase
      .from('calificaciones_cliente')
      .select(
        'solicitud_id, puntuacion, comentario, created_at, prestador:prestador_id(nombre)',
      )
      .eq('cliente_id', clienteId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(
        `Error obteniendo ratings de cliente: ${error.message}`,
      );
      throw new BadRequestException('Error obteniendo calificaciones');
    }

    // CAL-04: mismo criterio de reseña cruzada ciega que getRatingsPrestador,
    // en el sentido inverso (la contraparte acá es `calificaciones`).
    const ratings = await this.filtrarPorResenaCruzadaCompleta(
      supabase,
      data ?? [],
      'calificaciones',
    );
    const promedio = ratings.length
      ? Math.round(
          (ratings.reduce((sum, r: any) => sum + r.puntuacion, 0) /
            ratings.length) *
            100,
        ) / 100
      : null;

    return { ratings, promedio };
  }

  // CAL-04: dado un listado de reseñas (cada una con solicitud_id), devuelve
  // solo las que ya tienen su contraparte cargada en `contraparteTabla`
  // (calificaciones ↔ calificaciones_cliente) — y les saca el solicitud_id,
  // que era solo para este chequeo, no para exponerlo en la respuesta.
  private async filtrarPorResenaCruzadaCompleta(
    supabase: SupabaseClient,
    rows: any[],
    contraparteTabla: 'calificaciones' | 'calificaciones_cliente',
  ) {
    const solicitudIds = [
      ...new Set(rows.map((r) => r.solicitud_id).filter(Boolean)),
    ];
    if (!solicitudIds.length) return [];

    const { data: contrapartes } = await supabase
      .from(contraparteTabla)
      .select('solicitud_id')
      .in('solicitud_id', solicitudIds);

    const completas = new Set(
      (contrapartes ?? []).map((c: any) => c.solicitud_id),
    );

    return rows
      .filter((r) => completas.has(r.solicitud_id))
      .map(({ solicitud_id, ...rest }) => rest);
  }
}
