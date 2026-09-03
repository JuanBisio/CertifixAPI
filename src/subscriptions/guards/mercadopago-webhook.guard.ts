import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

// F7 (claude-security 2026-08-11): POST /subscriptions/webhook no validaba
// que la notificación viniera realmente de MercadoPago. El service ya re-consulta
// el preapproval real a MP antes de confiar en cualquier dato del body
// (syncPreapprovalStatus), así que esto es defensa en profundidad — no la única
// protección — pero cierra el ruido/spam de requests forjados.
//
// Algoritmo oficial de MercadoPago (x-signature: "ts=...,v1=...", x-request-id):
// manifest = `id:${data.id};request-id:${x-request-id};ts:${ts};`
// firma esperada = HMAC-SHA256(manifest, secret) en hex, comparado contra v1.
// La secret key se obtiene en el panel de MercadoPago (Developers > Tu app >
// Webhooks > Configurar notificaciones > "Firma secreta") y va en
// MERCADOPAGO_WEBHOOK_SECRET.
@Injectable()
export class MercadoPagoWebhookGuard implements CanActivate {
  private readonly logger = new Logger(MercadoPagoWebhookGuard.name);

  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secret = this.configService.get<string>(
      'MERCADOPAGO_WEBHOOK_SECRET',
    );

    // Sin secret configurado no hay nada que validar contra qué. No se rechaza
    // duro para no romper entornos donde todavía no se cargó el secret — el
    // re-fetch a MP en el service sigue siendo la protección real en ese caso.
    if (!secret) {
      this.logger.warn(
        'MERCADOPAGO_WEBHOOK_SECRET no configurado — se omite la validación de firma del webhook',
      );
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const signatureHeader = request.headers['x-signature'] as
      | string
      | undefined;
    const requestId = request.headers['x-request-id'] as string | undefined;
    const dataId = (request.query?.['data.id'] ?? request.query?.id) as
      | string
      | undefined;

    if (!signatureHeader || !requestId || !dataId) {
      this.logger.warn(
        'Webhook de MercadoPago sin headers/query de firma esperados — rechazado',
      );
      return false;
    }

    const parts: Record<string, string> = {};
    for (const pair of signatureHeader.split(',')) {
      const [key, value] = pair.split('=').map((s) => s?.trim());
      if (key && value) parts[key] = value;
    }

    const ts = parts.ts;
    const v1 = parts.v1;
    if (!ts || !v1) {
      this.logger.warn(
        'Webhook de MercadoPago con x-signature malformado — rechazado',
      );
      return false;
    }

    const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
    const expected = createHmac('sha256', secret)
      .update(manifest)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'utf8');
    const receivedBuf = Buffer.from(v1, 'utf8');
    const valid =
      expectedBuf.length === receivedBuf.length &&
      timingSafeEqual(expectedBuf, receivedBuf);

    if (!valid) {
      this.logger.warn('Firma de webhook de MercadoPago inválida — rechazado');
    }

    return valid;
  }
}
