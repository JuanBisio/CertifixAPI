import { AuthService } from '../auth/auth.service';
import { SubscriptionsService } from './subscriptions.service';

type Row = Record<string, any>;

/** Fake mínimo de la API fluida de Supabase: select/update + eq + single/maybeSingle. */
class FakeQuery {
  private filters: Array<[string, any]> = [];
  private patch?: Row;

  constructor(private rows: Row[]) {}

  select() {
    return this;
  }
  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push([col, val]);
    return this;
  }

  private matching() {
    return this.rows.filter((r) => this.filters.every(([c, v]) => r[c] === v));
  }

  single() {
    const [row] = this.matching();
    return Promise.resolve(
      row
        ? { data: { ...row }, error: null }
        : { data: null, error: { message: 'not found' } },
    );
  }
  maybeSingle() {
    const [row] = this.matching();
    return Promise.resolve({ data: row ? { ...row } : null, error: null });
  }

  then(resolve: any, reject?: any) {
    if (this.patch) {
      for (const row of this.matching()) Object.assign(row, this.patch);
    }
    return Promise.resolve({ data: null, error: null }).then(resolve, reject);
  }
}

function fakeSupabase(tables: Record<string, Row[]>) {
  const client = {
    from: (t: string) => new FakeQuery((tables[t] ??= [])),
    auth: { admin: { signOut: jest.fn().mockResolvedValue({ error: null }) } },
  };
  return { getServiceClient: () => client, client };
}

describe('SubscriptionsService.cancelIfActive', () => {
  function build(prestador: Row | null) {
    const tables = { perfiles_prestadores: prestador ? [prestador] : [] };
    const supabase = fakeSupabase(tables);
    const service = new SubscriptionsService(
      supabase as any,
      { get: () => 'TEST-token' } as any,
    );
    const preApproval = { update: jest.fn().mockResolvedValue({}) };
    (service as any).preApproval = preApproval;
    return { service, preApproval, tables };
  }

  it('cancela el preapproval en MP y marca suscripcion_cancelada si estaba vigente', async () => {
    const { service, preApproval, tables } = build({
      id: 'p1',
      mp_preapproval_id: 'pre-123',
      suscripcion_cancelada: false,
    });

    await expect(service.cancelIfActive('p1')).resolves.toBe(true);

    expect(preApproval.update).toHaveBeenCalledWith({
      id: 'pre-123',
      body: { status: 'cancelled' },
    });
    expect(tables.perfiles_prestadores[0].suscripcion_cancelada).toBe(true);
  });

  it('no llama a MP si ya estaba cancelada', async () => {
    const { service, preApproval } = build({
      id: 'p1',
      mp_preapproval_id: 'pre-123',
      suscripcion_cancelada: true,
    });

    await expect(service.cancelIfActive('p1')).resolves.toBe(false);
    expect(preApproval.update).not.toHaveBeenCalled();
  });

  it('no tira ni llama a MP si nunca se suscribió (cliente o prestador sin preapproval)', async () => {
    const { service, preApproval } = build(null);

    await expect(service.cancelIfActive('c1')).resolves.toBe(false);
    expect(preApproval.update).not.toHaveBeenCalled();
  });
});

describe('AuthService.requestAccountDeletion — suscripción', () => {
  function build(cancelIfActive: jest.Mock) {
    const tables = {
      perfiles: [{ id: 'u1', eliminacion_solicitada_at: null }] as Row[],
    };
    const supabase = fakeSupabase(tables);
    const service = new AuthService(
      supabase as any,
      {} as any,
      { cancelIfActive } as any,
    );
    return { service, tables };
  }

  it('cancela la suscripción del usuario al pedir la baja', async () => {
    const cancelIfActive = jest.fn().mockResolvedValue(true);
    const { service, tables } = build(cancelIfActive);

    await service.requestAccountDeletion('u1', 'jwt');

    expect(cancelIfActive).toHaveBeenCalledWith('u1');
    expect(tables.perfiles[0].eliminacion_solicitada_at).toEqual(
      expect.any(String),
    );
  });

  it('si MP falla, la baja igual queda registrada (no se le niega la baja al usuario)', async () => {
    const cancelIfActive = jest.fn().mockRejectedValue(new Error('MP caído'));
    const { service, tables } = build(cancelIfActive);

    await expect(
      service.requestAccountDeletion('u1', 'jwt'),
    ).resolves.toHaveProperty('message');
    expect(tables.perfiles[0].eliminacion_solicitada_at).toEqual(
      expect.any(String),
    );
  });
});
