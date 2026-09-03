import { Test } from '@nestjs/testing';
import { RatingsService } from './ratings.service';
import { SupabaseService } from '../supabase/supabase.service';

type Row = Record<string, any>;

/** Fake mínimo: solo lo que getRatingsPrestador/getRatingsCliente necesitan. */
class FakeQueryBuilder {
  private eqFilters: Array<[string, any]> = [];
  private inFilter?: [string, any[]];

  constructor(private rows: Row[]) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(col: string, val: any) {
    this.eqFilters.push([col, val]);
    return this;
  }
  in(col: string, vals: any[]) {
    this.inFilter = [col, vals];
    return this;
  }

  private matches(row: Row) {
    if (!this.eqFilters.every(([col, val]) => row[col] === val)) return false;
    if (this.inFilter) {
      const [col, vals] = this.inFilter;
      if (!vals.includes(row[col])) return false;
    }
    return true;
  }

  then(resolve: any, reject?: any) {
    const data = this.rows.filter((r) => this.matches(r));
    return Promise.resolve({ data, error: null }).then(resolve, reject);
  }
}

class FakeSupabaseClient {
  constructor(private db: Record<string, Row[]>) {}
  from(tableName: string) {
    return new FakeQueryBuilder(this.db[tableName] ?? []);
  }
}

class FakeSupabaseService {
  private client: FakeSupabaseClient;
  constructor(db: Record<string, Row[]>) {
    this.client = new FakeSupabaseClient(db);
  }
  getServiceClient() {
    return this.client;
  }
}

describe('RatingsService — CAL-04 (reseña cruzada ciega)', () => {
  const SOLICITUD_CON_AMBAS = 'sol-ambas';
  const SOLICITUD_SOLO_CLIENTE = 'sol-solo-cliente';
  const PRESTADOR_ID = 'prestador-1';

  const build = (db: Record<string, Row[]>) =>
    Test.createTestingModule({
      providers: [
        RatingsService,
        { provide: SupabaseService, useValue: new FakeSupabaseService(db) },
      ],
    })
      .compile()
      .then((m) => m.get(RatingsService));

  it('oculta la reseña del cliente hasta que el prestador también calificó esa solicitud', async () => {
    const service = await build({
      calificaciones: [
        {
          solicitud_id: SOLICITUD_CON_AMBAS,
          prestador_id: PRESTADOR_ID,
          puntuacion: 5,
          comentario: 'Excelente',
        },
        {
          solicitud_id: SOLICITUD_SOLO_CLIENTE,
          prestador_id: PRESTADOR_ID,
          puntuacion: 1,
          comentario: 'Reseña de venganza, todavía sin contraparte',
        },
      ],
      calificaciones_cliente: [
        { solicitud_id: SOLICITUD_CON_AMBAS, prestador_id: PRESTADOR_ID },
      ],
    });

    const { ratings } = await service.getRatingsPrestador(PRESTADOR_ID);

    expect(ratings).toHaveLength(1);
    expect(ratings[0].comentario).toBe('Excelente');
    // El solicitud_id era solo para el chequeo interno, no se expone.
    expect(ratings[0].solicitud_id).toBeUndefined();
  });

  it('muestra todas las reseñas ya cruzadas sin ocultar nada', async () => {
    const service = await build({
      calificaciones: [
        { solicitud_id: 'a', prestador_id: PRESTADOR_ID, puntuacion: 5 },
        { solicitud_id: 'b', prestador_id: PRESTADOR_ID, puntuacion: 4 },
      ],
      calificaciones_cliente: [
        { solicitud_id: 'a', prestador_id: PRESTADOR_ID },
        { solicitud_id: 'b', prestador_id: PRESTADOR_ID },
      ],
    });

    const { ratings } = await service.getRatingsPrestador(PRESTADOR_ID);
    expect(ratings).toHaveLength(2);
  });

  it('sin ninguna calificación no rompe (lista vacía)', async () => {
    const service = await build({ calificaciones: [], calificaciones_cliente: [] });
    const { ratings, promedios } = await service.getRatingsPrestador(PRESTADOR_ID);
    expect(ratings).toEqual([]);
    expect(promedios.comunicacion).toBeNull();
  });
});
