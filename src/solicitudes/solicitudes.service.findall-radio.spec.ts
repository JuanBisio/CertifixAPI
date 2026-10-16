import { Test } from '@nestjs/testing';
import { SolicitudesService } from './solicitudes.service';
import { SupabaseService } from '../supabase/supabase.service';
import { NotificationsService } from '../notifications/notifications.service';

type Row = Record<string, any>;

/**
 * SOL-04 — la lista "Solicitudes disponibles" (`GET /solicitudes`, rama
 * prestador) tiene que usar el MISMO radio que el push de la ronda.
 *
 * Si se desalinean pasa una de dos cosas, las dos malas: o el prestador ve en
 * la lista un trabajo al que todavía no lo pinchamos (y se lo lleva salteando
 * la escalera), o deja de ver uno para el que sí lo notificamos. Esta es la
 * misma clase de bug que la sección 3.12 del ROADMAP (la lista no filtraba por
 * geografía en absoluto).
 */
class FakeQueryBuilder {
  private filtros: Array<[string, string, any]> = [];

  constructor(private table: Row[]) {}

  select() {
    return this;
  }
  order() {
    return this;
  }
  eq(col: string, val: any) {
    this.filtros.push(['eq', col, val]);
    return this;
  }
  in(col: string, vals: any[]) {
    this.filtros.push(['in', col, vals]);
    return this;
  }

  private matches(row: Row) {
    return this.filtros.every(([op, col, val]) =>
      op === 'in' ? val.includes(row[col]) : row[col] === val,
    );
  }

  private execute() {
    return this.table.filter((r) => this.matches(r)).map((r) => ({ ...r }));
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
    return Promise.resolve({ data: this.execute(), error: null }).then(
      resolve,
      reject,
    );
  }
}

describe('SolicitudesService.findAll — radio por ronda (SOL-04)', () => {
  const PRESTADOR = 'p-1';
  // Córdoba Capital; el prestador está parado exactamente acá.
  const LON = -64.1888;
  const LAT = -31.4201;

  let service: SolicitudesService;
  let db: Record<string, Row[]>;

  // ~1 grado de longitud a esta latitud ≈ 95 km, así que 0.158 ≈ 15 km.
  const lonA = (km: number) => LON + km / 95;

  const solicitud = (id: string, km: number, ronda: number): Row => ({
    id,
    cliente_id: 'cli-1',
    prestador_id: null,
    rubro_id: '1',
    estado: 'buscando',
    urgencia: 'ahora',
    candidatos_count: 0,
    ronda_matching: ronda,
    ubicacion_difusa: `POINT(${lonA(km)} ${LAT})`,
  });

  const buildService = async (radioPrestadorKm: number, solicitudes: Row[]) => {
    db = {
      perfiles: [{ id: PRESTADOR, rol: 'prestador', suspendido: false }],
      perfiles_prestadores: [
        {
          id: PRESTADOR,
          esta_verificado: true,
          disponible: true,
          radio_km: radioPrestadorKm,
          ubicacion_base: `POINT(${LON} ${LAT})`,
        },
      ],
      prestador_rubros: [{ prestador_id: PRESTADOR, rubro_id: '1' }],
      solicitudes_trabajo: solicitudes,
      solicitud_candidatos: [],
    };

    const client = {
      from: (t: string) => {
        if (!db[t]) db[t] = [];
        return new FakeQueryBuilder(db[t]);
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SolicitudesService,
        {
          provide: SupabaseService,
          useValue: {
            getAuthenticatedClient: () => client,
            getServiceClient: () => client,
          },
        },
        {
          provide: NotificationsService,
          useValue: { notifyPrestadoresParaSolicitud: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(SolicitudesService);
  };

  const idsVisibles = async () => {
    const { solicitudes } = await service.findAll(PRESTADOR, 'token');
    return solicitudes.map((s: any) => s.id).sort();
  };

  it('en la ronda 1 no muestra un trabajo que todavía está fuera del radio de esa ronda', async () => {
    // Prestador con radio declarado 20 km. En la ronda 1 el radio es 10 km:
    // el trabajo a 15 km no le corresponde TODAVÍA, aunque entre en su radio.
    await buildService(20, [
      solicitud('cerca', 5, 1),
      solicitud('media', 15, 1),
    ]);

    expect(await idsVisibles()).toEqual(['cerca']);
  });

  it('cuando la solicitud avanza de ronda, el mismo trabajo aparece', async () => {
    await buildService(20, [solicitud('media', 15, 2)]);

    expect(await idsVisibles()).toEqual(['media']);
  });

  it('el radio de la ronda no le agranda la zona al prestador (rondas normales)', async () => {
    // Ronda 3 = 40 km, pero el prestador declaró 10 km: el trabajo a 15 km
    // sigue sin mostrársele.
    await buildService(10, [solicitud('media', 15, 3)]);

    expect(await idsVisibles()).toEqual([]);
  });

  it('la ronda de rescate sí pisa el radio declarado por el prestador', async () => {
    // Ronda 4 = 80 km, ignora el radio_km 10 del prestador.
    await buildService(10, [
      solicitud('media', 15, 4),
      solicitud('lejos', 90, 4),
    ]);

    expect(await idsVisibles()).toEqual(['media']);
  });
});
