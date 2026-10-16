import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { MercadoPagoWebhookGuard } from './guards/mercadopago-webhook.guard';
import { SupabaseAuthGuard } from '../common/guards/supabase-auth.guard';
import { createGlobalValidationPipe } from '../common/pipes/global-validation.pipe';

/**
 * Regresión: el webhook usaba un DTO con solo type/action/data, y el
 * ValidationPipe global (forbidNonWhitelisted) rechazaba con 400 cualquier
 * notificación real de MercadoPago, que siempre trae campos extra. Se prueba
 * por HTTP con el mismo pipe que usa main.ts, no llamando al método directo:
 * el bug vivía en el pipeline, no en el handler.
 */
describe('POST /subscriptions/webhook', () => {
  let app: INestApplication<App>;
  const handleWebhook = jest.fn().mockResolvedValue({ success: true });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SubscriptionsController],
      providers: [
        { provide: SubscriptionsService, useValue: { handleWebhook } },
      ],
    })
      .overrideGuard(MercadoPagoWebhookGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(SupabaseAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => handleWebhook.mockClear());

  it('acepta el payload real de subscription_preapproval (con campos extra) y pasa type/action/data.id', async () => {
    await request(app.getHttpServer())
      .post(
        '/subscriptions/webhook?data.id=2c9380847e1a&type=subscription_preapproval',
      )
      .send({
        action: 'updated',
        application_id: '1234567890123456',
        data: { id: '2c9380847e1a' },
        date: '2026-10-16T10:00:00.000-03:00',
        entity: 'preapproval',
        id: 115583459011,
        type: 'subscription_preapproval',
        version: 3,
      })
      .expect(200);

    expect(handleWebhook).toHaveBeenCalledTimes(1);
    expect(handleWebhook).toHaveBeenCalledWith({
      type: 'subscription_preapproval',
      action: 'updated',
      data: { id: '2c9380847e1a' },
    });
  });

  it('acepta el formato clásico (live_mode, user_id, api_version) con data.id numérico', async () => {
    await request(app.getHttpServer())
      .post('/subscriptions/webhook')
      .send({
        id: 12345,
        live_mode: true,
        type: 'subscription_authorized_payment',
        date_created: '2026-10-16T10:00:00.000-03:00',
        user_id: 44444,
        api_version: 'v1',
        action: 'created',
        data: { id: 7001234567 },
      })
      .expect(200);

    expect(handleWebhook).toHaveBeenCalledWith({
      type: 'subscription_authorized_payment',
      action: 'created',
      data: { id: '7001234567' },
    });
  });

  it('un body sin data no rompe: llega sin data.id y el service lo ignora', async () => {
    await request(app.getHttpServer())
      .post('/subscriptions/webhook')
      .send({ type: 'test', foo: 'bar' })
      .expect(200);

    expect(handleWebhook).toHaveBeenCalledWith({
      type: 'test',
      action: undefined,
      data: undefined,
    });
  });
});
