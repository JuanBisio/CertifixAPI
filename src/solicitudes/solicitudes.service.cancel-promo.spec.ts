import { Test } from '@nestjs/testing';
import { SolicitudesService } from './solicitudes.service';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

type Row = Record<string, any>;

/**
 * Fake Postgrest-like query builder (extiende el patrón de
 * solicitudes.service.spec.ts agregando insert() y soporte para awaitear
 * directamente sin .single(), que cancel()/updateStatus() usan para
 * strikes_historial, evidencias y perfiles_prestadores).
 */
class FakeQueryBuilder {
  private eqFilters: Array<[string, any]> = [];
  private updateData?: Row;
  private insertData?: Row;

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

  update(data: Row) {
    this.updateData = data;
    return this;
  }

  insert(data: Row) {
    this.insertData = data;
    return this;
  }

  private matches(row: Row) {
    return this.eqFilters.every(([col, val]) => row[col] === val);
  }

  // Síncrono a propósito (mismo motivo que en solicitudes.service.spec.ts):
  // deja que single()/then() resuelvan el match+update sin interleaving.
  private execute(): { data: Row[]; error: null } {
    if (this.insertData) {
      const id = this.insertData.id ?? `${this.tableName}-${this.table.size + 1}`;
      const row: Row = { id, ...this.insertData };
      this.table.set(id, row);
      return { data: [row], error: null };
    }

    const matched = [...this.table.values()].filter((row) => this.matches(row));
    if (this.updateData) {
      matched.forEach((row) => Object.assign(row, this.updateData));
    }
    return { data: matched.map((r) => ({ ...r })), error: null };
  }

  single() {
    const { data } = this.execute();
    if (!data.length) {
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST116', message: 'No rows found' },
      });
    }
    const result: Row = { ...data[0] };
    if (this.tableName === 'solicitudes_trabajo') {
      result.rubros = {
        id: result.rubro_id,
        nombre: 'Plomería',
        icono: 'wrench',
      };
    }
    return Promise.resolve({ data: result, error: null });
  }

  // Permite `await supabase.from(x)...` sin .single() (insert de historial,
  // update de evidencias/perfiles_prestadores, select de candidatos).
  then(resolve: any, reject?: any) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

class FakeSupabaseClient {
  constructor(
    private db: Record<string, Map<string, Row>>,
    private rpcHandlers: Record<string, (params: any) => any>,
  ) {}

  from(tableName: string) {
    if (!this.db[tableName]) this.db[tableName] = new Map();
    return new FakeQueryBuilder(this.db[tableName], tableName);
  }

  rpc(name: string, params: any) {
    const handler = this.rpcHandlers[name];
    return Promise.resolve(
      handler ? handler(params) : { data: null, error: null },
    );
  }
}

class FakeSupabaseService {
  private client: FakeSupabaseClient;

  constructor(
    private db: Record<string, Map<string, Row>>,
    private rpcHandlers: Record<string, (params: any) => any> = {},
  ) {
    this.client = new FakeSupabaseClient(db, rpcHandlers);
  }

  // El código real usa un cliente distinto (JWT del usuario) del service
  // client (bypass RLS), pero ambos deben ver la misma data en el test.
  getAuthenticatedClient() {
    return this.client;
  }

  getServiceClient() {
    return this.client;
  }
}

describe('SolicitudesService.cancel — cancelación con consecuencias (CAN-02/03/04)', () => {
  const SOLICITUD_ID = 'solicitud-1';
  const CLIENTE_ID = 'cliente-1';
  const PRESTADOR_ID = 'prestador-1';

  let db: Record<string, Map<string, Row>>;
  let service: SolicitudesService;
  let notifyUsers: jest.Mock;
  let incrementStrikes: jest.Mock;

  const buildService = async (solicitudOverrides: Row) => {
    db = {
      perfiles: new Map([
        [CLIENTE_ID, { id: CLIENTE_ID, rol: 'cliente' }],
        [PRESTADOR_ID, { id: PRESTADOR_ID, rol: 'prestador' }],
      ]),
      perfiles_prestadores: new Map([
        [PRESTADOR_ID, { id: PRESTADOR_ID, disponible: false }],
      ]),
      solicitudes_trabajo: new Map([
        [
          SOLICITUD_ID,
          {
            id: SOLICITUD_ID,
            cliente_id: CLIENTE_ID,
            prestador_id: PRESTADOR_ID,
            rubro_id: 'rubro-plomeria',
            estado: 'aceptado',
            urgencia: 'ahora',
            aceptado_at: new Date().toISOString(),
            ...solicitudOverrides,
          },
        ],
      ]),
      solicitud_candidatos: new Map(),
      strikes_historial: new Map(),
    };

    notifyUsers = jest.fn().mockResolvedValue(undefined);
    incrementStrikes = jest
      .fn()
      .mockReturnValue({ data: [{ strikes_count: 1, suspendido: false }], error: null });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SolicitudesService,
        {
          provide: SupabaseService,
          useValue: new FakeSupabaseService(db, {
            increment_strikes: incrementStrikes,
          }),
        },
        { provide: NotificationsService, useValue: { notifyUsers } },
      ],
    }).compile();

    service = moduleRef.get(SolicitudesService);
  };

  it('el prestador cancela un trabajo urgente ya aceptado → suma un strike', async () => {
    await buildService({ urgencia: 'ahora' });

    await service.cancel(SOLICITUD_ID, PRESTADOR_ID, 'token');

    expect(incrementStrikes).toHaveBeenCalledWith({ p_perfil_id: PRESTADOR_ID });

    const historial = [...db.strikes_historial.values()];
    expect(historial).toHaveLength(1);
    expect(historial[0].perfil_id).toBe(PRESTADOR_ID);
    expect(historial[0].trabajo_id).toBe(SOLICITUD_ID);

    const row = db.solicitudes_trabajo.get(SOLICITUD_ID)!;
    expect(row.estado).toBe('buscando');
    expect(row.prestador_id).toBeNull();
  });

  it('el prestador cancela un trabajo programado dentro de las 12hs de aceptado → NO suma strike', async () => {
    await buildService({
      urgencia: 'programado',
      aceptado_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // hace 2hs
    });

    await service.cancel(SOLICITUD_ID, PRESTADOR_ID, 'token');

    expect(incrementStrikes).not.toHaveBeenCalled();
    expect(db.strikes_historial.size).toBe(0);

    const row = db.solicitudes_trabajo.get(SOLICITUD_ID)!;
    expect(row.estado).toBe('buscando');
    expect(row.candidatos_count).toBe(0);
  });

  it('el prestador cancela un trabajo programado más de 12hs después de aceptado → sí suma strike', async () => {
    await buildService({
      urgencia: 'programado',
      aceptado_at: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(), // hace 13hs
    });

    await service.cancel(SOLICITUD_ID, PRESTADOR_ID, 'token');

    expect(incrementStrikes).toHaveBeenCalledWith({ p_perfil_id: PRESTADOR_ID });
    expect(db.strikes_historial.size).toBe(1);
  });

  it('suspende y notifica cuando el RPC de strikes devuelve suspendido=true', async () => {
    await buildService({ urgencia: 'ahora' });
    incrementStrikes.mockReturnValue({
      data: [{ strikes_count: 3, suspendido: true }],
      error: null,
    });

    await service.cancel(SOLICITUD_ID, PRESTADOR_ID, 'token');

    expect(notifyUsers).toHaveBeenCalledWith(
      [PRESTADOR_ID],
      'Tu cuenta fue suspendida',
      expect.any(String),
      'token',
      {},
    );
  });

  it('el cliente cancela un trabajo urgente ya aceptado → el strike también le suma a él (no solo al prestador)', async () => {
    await buildService({ urgencia: 'ahora' });

    await service.cancel(SOLICITUD_ID, CLIENTE_ID, 'token');

    // sumaStrike se calcula solo a partir de solicitud.estado/urgencia/
    // aceptado_at — no discrimina isPrestador — así que increment_strikes
    // se llama con el userId de quien canceló, sea cliente o prestador.
    // Este test deja fijado ese comportamiento simétrico.
    expect(incrementStrikes).toHaveBeenCalledWith({ p_perfil_id: CLIENTE_ID });
    const row = db.solicitudes_trabajo.get(SOLICITUD_ID)!;
    expect(row.estado).toBe('cancelado');
  });
});

describe('SolicitudesService.updateStatus — promo de lanzamiento (3 trabajos gratis)', () => {
  const SOLICITUD_ID = 'solicitud-1';
  const CLIENTE_ID = 'cliente-1';
  const PRESTADOR_ID = 'prestador-1';

  let db: Record<string, Map<string, Row>>;
  let service: SolicitudesService;
  let incrementTrabajosGratis: jest.Mock;

  beforeEach(async () => {
    db = {
      solicitudes_trabajo: new Map([
        [
          SOLICITUD_ID,
          {
            id: SOLICITUD_ID,
            cliente_id: CLIENTE_ID,
            prestador_id: PRESTADOR_ID,
            rubro_id: 'rubro-plomeria',
            estado: 'en_trabajo',
          },
        ],
      ]),
      evidencias: new Map(),
    };

    incrementTrabajosGratis = jest.fn().mockReturnValue({ data: null, error: null });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SolicitudesService,
        {
          provide: SupabaseService,
          useValue: new FakeSupabaseService(db, {
            increment_trabajos_gratis_usados: incrementTrabajosGratis,
          }),
        },
        {
          provide: NotificationsService,
          useValue: { notifyUsers: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = moduleRef.get(SolicitudesService);
  });

  it('al marcar finalizado, descuenta un crédito de promo del prestador asignado (RPC atómica)', async () => {
    await service.updateStatus(
      SOLICITUD_ID,
      PRESTADOR_ID,
      { estado: 'finalizado' } as any,
      'token',
    );

    expect(incrementTrabajosGratis).toHaveBeenCalledWith({
      p_prestador_id: PRESTADOR_ID,
    });

    const row = db.solicitudes_trabajo.get(SOLICITUD_ID)!;
    expect(row.estado).toBe('finalizado');
  });

  it('no descuenta crédito en transiciones que no sean finalizado (en_camino)', async () => {
    db.solicitudes_trabajo.set(SOLICITUD_ID, {
      id: SOLICITUD_ID,
      cliente_id: CLIENTE_ID,
      prestador_id: PRESTADOR_ID,
      rubro_id: 'rubro-plomeria',
      estado: 'aceptado',
    });

    await service.updateStatus(
      SOLICITUD_ID,
      PRESTADOR_ID,
      { estado: 'en_camino' } as any,
      'token',
    );

    expect(incrementTrabajosGratis).not.toHaveBeenCalled();
  });
});
