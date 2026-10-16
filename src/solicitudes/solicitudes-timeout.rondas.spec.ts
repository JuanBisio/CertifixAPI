import { Test } from '@nestjs/testing';
import { SolicitudesTimeoutService } from './solicitudes-timeout.service';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

type Row = Record<string, any>;

/**
 * SOL-04 — motor de rondas del radio adaptativo (escalera 10 → 20 → 40 → 80).
 *
 * Lo que fija este spec:
 *  - la ronda NO avanza antes del intervalo que corresponde;
 *  - el intervalo depende de si la ronda actual notificó a alguien (2 min si
 *    quedó vacía, 4 min en urgente / 20 min en programado si notificó);
 *  - la última ronda va con `ignorarRadioPrestador`, las anteriores no;
 *  - la escalera se termina en la última ronda;
 *  - programado con cupo lleno o plazo vencido no amplía;
 *  - el avance es CAS: dos pasadas concurrentes no disparan dos rondas.
 */
class FakeQueryBuilder {
  private filtros: Array<[string, string, any]> = [];
  private updateData?: Row;
  private headCount = false;

  constructor(
    private table: Row[],
    private tableName: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.headCount = !!opts?.head;
    return this;
  }

  eq(col: string, val: any) {
    this.filtros.push(['eq', col, val]);
    return this;
  }
  is(col: string, val: any) {
    this.filtros.push(['is', col, val]);
    return this;
  }
  lt(col: string, val: any) {
    this.filtros.push(['lt', col, val]);
    return this;
  }
  not(col: string, _op: string, val: any) {
    this.filtros.push(['not-is', col, val]);
    return this;
  }

  update(data: Row) {
    this.updateData = data;
    return this;
  }

  private matches(row: Row) {
    return this.filtros.every(([op, col, val]) => {
      const actual = row[col];
      if (op === 'eq') return actual === val;
      if (op === 'is') return (actual ?? null) === val;
      if (op === 'not-is') return (actual ?? null) !== val;
      if (op === 'lt') return actual < val;
      return true;
    });
  }

  // Síncrono a propósito (mismo criterio que solicitudes.service.spec.ts):
  // el match + update resuelven juntos, sin interleaving en el medio, que es
  // justo lo que hace del `.eq('ronda_matching', n)` un CAS real.
  private execute() {
    const matched = this.table.filter((r) => this.matches(r));
    if (this.updateData)
      matched.forEach((r) => Object.assign(r, this.updateData));
    return matched.map((r) => ({ ...r }));
  }

  single() {
    const data = this.execute();
    return Promise.resolve(
      data.length
        ? { data: data[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'No rows found' } },
    );
  }

  then(resolve: any, reject?: any) {
    const data = this.execute();
    return Promise.resolve(
      this.headCount
        ? { data: null, error: null, count: data.length }
        : { data, error: null, count: data.length },
    ).then(resolve, reject);
  }
}

const MIN = 60 * 1000;

describe('SolicitudesTimeoutService.avanzarRondasDeMatching (SOL-04)', () => {
  const SOLICITUD = 'sol-1';
  let service: SolicitudesTimeoutService;
  let db: Record<string, Row[]>;
  let notifyRonda: jest.Mock;

  const solicitudBase = (over: Row = {}): Row => ({
    id: SOLICITUD,
    cliente_id: 'cli-1',
    prestador_id: null,
    rubro_id: '1',
    descripcion: 'Pierde la canilla',
    estado: 'buscando',
    urgencia: 'ahora',
    franjas_horarias: null,
    candidatos_count: 0,
    postulacion_deadline_at: null,
    ronda_matching: 1,
    ronda_matching_at: new Date(Date.now() - 10 * MIN).toISOString(),
    created_at: new Date(Date.now() - 10 * MIN).toISOString(),
    ubicacion_privada: { ubicacion_real: 'POINT(-64.1888 -31.4201)' },
    ...over,
  });

  const buildService = async (
    solicitudes: Row[],
    notificaciones: Row[] = [],
  ) => {
    db = {
      solicitudes_trabajo: solicitudes,
      solicitud_notificaciones: notificaciones,
      expo_push_tokens: [],
    };
    const client = {
      from: (t: string) => {
        if (!db[t]) db[t] = [];
        return new FakeQueryBuilder(db[t], t);
      },
    };
    notifyRonda = jest.fn().mockResolvedValue(1);

    const moduleRef = await Test.createTestingModule({
      providers: [
        SolicitudesTimeoutService,
        {
          provide: SupabaseService,
          useValue: { getServiceClient: () => client },
        },
        {
          provide: NotificationsService,
          useValue: { notifyPrestadoresParaSolicitud: notifyRonda },
        },
      ],
    }).compile();

    service = moduleRef.get(SolicitudesTimeoutService);
    jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
    jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
  };

  const ronda = () => db.solicitudes_trabajo[0].ronda_matching;

  it('no amplía antes de que venza el intervalo de la ronda', async () => {
    await buildService([
      solicitudBase({
        ronda_matching_at: new Date(Date.now() - 1 * MIN).toISOString(),
      }),
    ]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(1);
    expect(notifyRonda).not.toHaveBeenCalled();
  });

  it('urgente: si la ronda quedó vacía amplía a los 2 min, con el radio siguiente', async () => {
    await buildService([
      solicitudBase({
        ronda_matching_at: new Date(Date.now() - 3 * MIN).toISOString(),
      }),
    ]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(2);
    expect(notifyRonda).toHaveBeenCalledWith(
      expect.objectContaining({
        solicitudId: SOLICITUD,
        ronda: 2,
        radioKm: 20,
        ignorarRadioPrestador: false,
        lon: -64.1888,
        lat: -31.4201,
      }),
    );
  });

  it('urgente: si la ronda ya notificó a alguien espera el intervalo largo (4 min)', async () => {
    await buildService(
      [
        solicitudBase({
          ronda_matching_at: new Date(Date.now() - 3 * MIN).toISOString(),
        }),
      ],
      [{ id: 'n1', solicitud_id: SOLICITUD, prestador_id: 'p1', ronda: 1 }],
    );

    await service.avanzarRondasDeMatching();
    expect(ronda()).toBe(1);
    expect(notifyRonda).not.toHaveBeenCalled();

    // A los 5 minutos sí amplía.
    db.solicitudes_trabajo[0].ronda_matching_at = new Date(
      Date.now() - 5 * MIN,
    ).toISOString();
    await service.avanzarRondasDeMatching();
    expect(ronda()).toBe(2);
  });

  it('programado: con notificados en la ronda espera 20 min, no 4', async () => {
    await buildService(
      [
        solicitudBase({
          urgencia: 'programado',
          postulacion_deadline_at: new Date(
            Date.now() + 60 * MIN,
          ).toISOString(),
          ronda_matching_at: new Date(Date.now() - 10 * MIN).toISOString(),
        }),
      ],
      [{ id: 'n1', solicitud_id: SOLICITUD, prestador_id: 'p1', ronda: 1 }],
    );

    await service.avanzarRondasDeMatching();
    expect(ronda()).toBe(1);

    db.solicitudes_trabajo[0].ronda_matching_at = new Date(
      Date.now() - 21 * MIN,
    ).toISOString();
    await service.avanzarRondasDeMatching();
    expect(ronda()).toBe(2);
    expect(notifyRonda).toHaveBeenCalledWith(
      expect.objectContaining({ ronda: 2, radioKm: 20 }),
    );
  });

  it('la última ronda va con ignorarRadioPrestador y 80 km', async () => {
    await buildService([solicitudBase({ ronda_matching: 3 })]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(4);
    expect(notifyRonda).toHaveBeenCalledWith(
      expect.objectContaining({
        ronda: 4,
        radioKm: 80,
        ignorarRadioPrestador: true,
      }),
    );
  });

  it('no sigue ampliando después de la última ronda', async () => {
    await buildService([solicitudBase({ ronda_matching: 4 })]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(4);
    expect(notifyRonda).not.toHaveBeenCalled();
  });

  it('programado: no amplía si ya se llenó el cupo de 3 candidatos', async () => {
    await buildService([
      solicitudBase({
        urgencia: 'programado',
        candidatos_count: 3,
        postulacion_deadline_at: new Date(Date.now() + 60 * MIN).toISOString(),
      }),
    ]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(1);
    expect(notifyRonda).not.toHaveBeenCalled();
  });

  it('programado: no amplía si venció el plazo de postulación', async () => {
    await buildService([
      solicitudBase({
        urgencia: 'programado',
        postulacion_deadline_at: new Date(Date.now() - 1 * MIN).toISOString(),
      }),
    ]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(1);
    expect(notifyRonda).not.toHaveBeenCalled();
  });

  it('no toca solicitudes que ya salieron de `buscando`', async () => {
    await buildService([
      solicitudBase({ estado: 'aceptado', prestador_id: 'p1' }),
    ]);

    await service.avanzarRondasDeMatching();

    expect(ronda()).toBe(1);
    expect(notifyRonda).not.toHaveBeenCalled();
  });

  it('dos pasadas concurrentes avanzan una sola ronda (CAS sobre ronda_matching)', async () => {
    await buildService([solicitudBase()]);

    await Promise.all([
      service.avanzarRondasDeMatching(),
      service.avanzarRondasDeMatching(),
    ]);

    expect(ronda()).toBe(2);
    expect(notifyRonda).toHaveBeenCalledTimes(1);
  });
});
