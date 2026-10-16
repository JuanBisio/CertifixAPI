import { Test } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { SupabaseService } from '../supabase/supabase.service';

type Row = Record<string, any>;

/**
 * SOL-04 — rondas del radio adaptativo, lado notificación.
 *
 * Cubre lo que el motor de rondas da por sentado:
 *  - la ronda le pasa su radio (y el flag de rescate) al RPC de matching;
 *  - un prestador que ya recibió el push en una ronda anterior no lo recibe
 *    de nuevo (`p_excluir_prestadores` + tabla `solicitud_notificaciones`);
 *  - si el RPC falla, el fallback en TS aplica EXACTAMENTE el mismo criterio
 *    de radio (min con el radio_km del prestador, salvo en rescate) — si se
 *    desalinean vuelve a pasar lo de la sección 3.12 del ROADMAP;
 *  - los tokens de push se leen con el service client (ver más abajo).
 */
class FakeQueryBuilder {
  private filtros: Array<[string, string, any]> = [];
  private upsertRows?: Row[];

  constructor(
    private table: Row[],
    private tableName: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.headCount = !!opts?.head;
    return this;
  }
  private headCount = false;

  eq(col: string, val: any) {
    this.filtros.push(['eq', col, val]);
    return this;
  }

  in(col: string, vals: any[]) {
    this.filtros.push(['in', col, vals]);
    return this;
  }

  or(_expr: string) {
    // El filtro de suscripción/promo no se ejercita acá: los fixtures ya
    // representan prestadores con acceso vigente.
    return this;
  }

  upsert(rows: Row[], _opts?: any) {
    this.upsertRows = rows;
    return this;
  }

  private matches(row: Row) {
    return this.filtros.every(([op, col, val]) =>
      op === 'in' ? val.includes(row[col]) : row[col] === val,
    );
  }

  then(resolve: any, reject?: any) {
    if (this.upsertRows) {
      for (const nueva of this.upsertRows) {
        const yaEsta = this.table.some(
          (r) =>
            r.solicitud_id === nueva.solicitud_id &&
            r.prestador_id === nueva.prestador_id,
        );
        if (!yaEsta)
          this.table.push({
            id: `${this.tableName}-${this.table.length + 1}`,
            ...nueva,
          });
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }

    const data = this.table
      .filter((r) => this.matches(r))
      .map((r) => ({ ...r }));
    return Promise.resolve({ data, error: null, count: data.length }).then(
      resolve,
      reject,
    );
  }
}

describe('NotificationsService.notifyPrestadoresParaSolicitud — rondas (SOL-04)', () => {
  const SOLICITUD = 'sol-1';
  const RUBRO = '1';
  // Córdoba Capital, mismas coordenadas de prueba que la sección 3.12.
  const LON = -64.1888;
  const LAT = -31.4201;

  let service: NotificationsService;
  let db: Record<string, Row[]>;
  let rpcCalls: any[];
  let rpcResult: { data: any; error: any };
  let getAuthenticatedClient: jest.Mock;
  let fetchMock: jest.Mock;

  const buildService = async () => {
    db = {
      solicitud_notificaciones: [],
      expo_push_tokens: [
        { user_id: 'p-cerca', expo_push_token: 'ExponentPushToken[cerca]' },
        { user_id: 'p-lejos', expo_push_token: 'ExponentPushToken[lejos]' },
      ],
      prestador_rubros: [
        { prestador_id: 'p-cerca', rubro_id: RUBRO },
        { prestador_id: 'p-lejos', rubro_id: RUBRO },
      ],
      perfiles_prestadores: [
        // ~0 km del punto de la solicitud, radio declarado 10.
        {
          id: 'p-cerca',
          radio_km: 10,
          disponible: true,
          esta_verificado: true,
          ubicacion_base: `POINT(${LON} ${LAT})`,
        },
        // ~30 km al oeste, radio declarado 10 → fuera de su propio radio.
        {
          id: 'p-lejos',
          radio_km: 10,
          disponible: true,
          esta_verificado: true,
          ubicacion_base: `POINT(${LON - 0.3157} ${LAT})`,
        },
      ],
    };
    rpcCalls = [];
    rpcResult = { data: [], error: null };

    const client = {
      from: (t: string) => {
        if (!db[t]) db[t] = [];
        return new FakeQueryBuilder(db[t], t);
      },
      rpc: (name: string, params: any) => {
        rpcCalls.push({ name, params });
        return Promise.resolve(rpcResult);
      },
    };
    getAuthenticatedClient = jest.fn(() => client);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: SupabaseService,
          useValue: {
            getServiceClient: () => client,
            getAuthenticatedClient,
          },
        },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);
  };

  const notificar = (over: Partial<any> = {}) =>
    service.notifyPrestadoresParaSolicitud({
      solicitudId: SOLICITUD,
      rubroId: RUBRO,
      lon: LON,
      lat: LAT,
      payload: { title: 't', body: 'b' },
      ronda: 2,
      radioKm: 20,
      ignorarRadioPrestador: false,
      ...over,
    });

  beforeEach(async () => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });
    (global as any).fetch = fetchMock;
    await buildService();
  });

  it('le pasa al RPC el radio de la ronda y el flag de rescate', async () => {
    rpcResult = { data: [{ user_id: 'p-cerca' }], error: null };

    await notificar({ ronda: 4, radioKm: 80, ignorarRadioPrestador: true });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].params).toMatchObject({
      p_rubro_id: RUBRO,
      p_radio_km: 80,
      p_ignorar_radio_prestador: true,
    });
  });

  it('no re-notifica en la ronda siguiente a quien ya recibió el push', async () => {
    rpcResult = { data: [{ user_id: 'p-cerca' }], error: null };
    const notificados1 = await notificar({ ronda: 1, radioKm: 10 });

    expect(notificados1).toBe(1);
    expect(db.solicitud_notificaciones).toEqual([
      expect.objectContaining({
        solicitud_id: SOLICITUD,
        prestador_id: 'p-cerca',
        ronda: 1,
      }),
    ]);

    // Ronda 2: el RPC tiene que recibir a p-cerca en la lista de excluidos.
    rpcResult = { data: [], error: null };
    const notificados2 = await notificar({ ronda: 2, radioKm: 20 });

    expect(rpcCalls[1].params.p_excluir_prestadores).toEqual(['p-cerca']);
    expect(notificados2).toBe(0);
    // Y no se manda ningún push nuevo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('el fallback aplica el mismo min(radio_ronda, radio_km) que el RPC', async () => {
    // El RPC falla → cae al filtro Haversine en TS.
    rpcResult = {
      data: null,
      error: {
        message: 'type "geography" does not exist',
        code: '42704',
        details: 'd',
        hint: 'h',
      },
    };
    const logError = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    // Ronda 3 (40 km): p-lejos está a ~30 km, dentro del radio de la ronda,
    // pero declaró radio_km 10 → sigue afuera. Solo entra p-cerca.
    const notificados = await notificar({ ronda: 3, radioKm: 40 });

    expect(notificados).toBe(1);
    expect(db.solicitud_notificaciones.map((r) => r.prestador_id)).toEqual([
      'p-cerca',
    ]);
    // El error del RPC se loguea completo, no en silencio.
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('code=42704'),
    );
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('hint=h'));
  });

  it('el fallback en la ronda de rescate sí pisa el radio_km del prestador', async () => {
    rpcResult = {
      data: null,
      error: { message: 'boom', code: 'X', details: null, hint: null },
    };
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    const notificados = await notificar({
      ronda: 4,
      radioKm: 80,
      ignorarRadioPrestador: true,
    });

    expect(notificados).toBe(2);
    expect(
      db.solicitud_notificaciones.map((r) => r.prestador_id).sort(),
    ).toEqual(['p-cerca', 'p-lejos']);
  });

  it('lee los expo push tokens con el service client, no con el JWT del actor', async () => {
    // Regresión: la policy RLS de expo_push_tokens es `user_id = auth.uid()`
    // FOR ALL, así que leer los tokens con el token del que dispara la
    // notificación devuelve cero filas para cualquier push dirigido a otro.
    rpcResult = { data: [{ user_id: 'p-cerca' }], error: null };

    await notificar({ ronda: 1, radioKm: 10 });

    expect(getAuthenticatedClient).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[cerca]' }),
    ]);
  });
});
