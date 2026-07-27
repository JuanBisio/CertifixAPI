import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { SolicitudesService } from './solicitudes.service';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

type Row = Record<string, any>;

/**
 * Fake Postgrest-like query builder. `single()` is intentionally a plain
 * (non-async) function: it resolves synchronously to completion before
 * yielding, so two "concurrent" callers can never interleave mid-query —
 * exactly like a single real SQL UPDATE statement. That's what makes the
 * race-condition test below deterministic instead of flaky.
 */
class FakeQueryBuilder {
  private eqFilters: Array<[string, any]> = [];
  private isNullFilters: string[] = [];
  private inFilter?: [string, any[]];
  private updateData?: Row;

  constructor(
    private table: Map<string, Row>,
    private tableName: string,
  ) {}

  select() {
    return this;
  }

  eq(col: string, val: any) {
    this.eqFilters.push([col, val]);
    return this;
  }

  is(col: string, val: null) {
    this.isNullFilters.push(col);
    void val;
    return this;
  }

  in(col: string, vals: any[]) {
    this.inFilter = [col, vals];
    return this;
  }

  update(data: Row) {
    this.updateData = data;
    return this;
  }

  private matches(row: Row) {
    if (!this.eqFilters.every(([col, val]) => row[col] === val)) return false;
    if (
      !this.isNullFilters.every(
        (col) => row[col] === null || row[col] === undefined,
      )
    )
      return false;
    if (this.inFilter) {
      const [col, vals] = this.inFilter;
      if (!vals.includes(row[col])) return false;
    }
    return true;
  }

  single() {
    const match = [...this.table.values()].find((row) => this.matches(row));

    if (!match) {
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST116', message: 'No rows found' },
      });
    }

    if (this.updateData) {
      Object.assign(match, this.updateData);
    }

    const result: Row = { ...match };
    if (this.tableName === 'solicitudes_trabajo') {
      result.rubros = {
        id: match.rubro_id,
        nombre: 'Plomería',
        icono: 'wrench',
      };
    }
    return Promise.resolve({ data: result, error: null });
  }
}

class FakeSupabaseClient {
  constructor(private db: Record<string, Map<string, Row>>) {}

  from(tableName: string) {
    if (!this.db[tableName]) this.db[tableName] = new Map();
    return new FakeQueryBuilder(this.db[tableName], tableName);
  }
}

class FakeSupabaseService {
  private client: FakeSupabaseClient;

  constructor(private db: Record<string, Map<string, Row>>) {
    this.client = new FakeSupabaseClient(db);
  }

  getAuthenticatedClient() {
    return this.client;
  }
}

describe('SolicitudesService.accept — carrera atómica', () => {
  const SOLICITUD_ID = 'solicitud-1';
  const RUBRO_ID = 'rubro-plomeria';
  const PRESTADOR_A = 'prestador-a';
  const PRESTADOR_B = 'prestador-b';

  let db: Record<string, Map<string, Row>>;
  let service: SolicitudesService;
  let notifyUsers: jest.Mock;

  beforeEach(async () => {
    db = {
      perfiles: new Map([
        [PRESTADOR_A, { id: PRESTADOR_A, rol: 'prestador' }],
        [PRESTADOR_B, { id: PRESTADOR_B, rol: 'prestador' }],
      ]),
      perfiles_prestadores: new Map([
        [
          PRESTADOR_A,
          { id: PRESTADOR_A, esta_verificado: true, disponible: true },
        ],
        [
          PRESTADOR_B,
          { id: PRESTADOR_B, esta_verificado: true, disponible: true },
        ],
      ]),
      solicitudes_trabajo: new Map([
        [
          SOLICITUD_ID,
          {
            id: SOLICITUD_ID,
            cliente_id: 'cliente-1',
            rubro_id: RUBRO_ID,
            estado: 'buscando',
            tipo_tecnico: null,
            prestador_id: null,
          },
        ],
      ]),
      prestador_rubros: new Map([
        ['pr-a', { id: 'pr-a', prestador_id: PRESTADOR_A, rubro_id: RUBRO_ID }],
        ['pr-b', { id: 'pr-b', prestador_id: PRESTADOR_B, rubro_id: RUBRO_ID }],
      ]),
    };

    notifyUsers = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SolicitudesService,
        { provide: SupabaseService, useValue: new FakeSupabaseService(db) },
        { provide: NotificationsService, useValue: { notifyUsers } },
      ],
    }).compile();

    service = moduleRef.get(SolicitudesService);
  });

  it('deja ganar exactamente a un prestador cuando dos aceptan a la vez', async () => {
    const results = await Promise.allSettled([
      service.accept(SOLICITUD_ID, PRESTADOR_A, 'token-a'),
      service.accept(SOLICITUD_ID, PRESTADOR_B, 'token-b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const winnerId = (fulfilled[0] as PromiseFulfilledResult<any>).value
      .solicitud.prestador_id;
    expect([PRESTADOR_A, PRESTADOR_B]).toContain(winnerId);

    const finalRow = db.solicitudes_trabajo.get(SOLICITUD_ID)!;
    expect(finalRow.estado).toBe('aceptado');
    expect(finalRow.prestador_id).toBe(winnerId);

    expect(notifyUsers).toHaveBeenCalledTimes(1);
  });

  it('rechaza a un segundo prestador cuando el trabajo ya fue aceptado antes de que llegue', async () => {
    await service.accept(SOLICITUD_ID, PRESTADOR_A, 'token-a');

    await expect(
      service.accept(SOLICITUD_ID, PRESTADOR_B, 'token-b'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(notifyUsers).toHaveBeenCalledTimes(1);
  });
});
