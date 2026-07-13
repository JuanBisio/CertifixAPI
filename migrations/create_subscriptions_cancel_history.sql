-- Migration: Fixes de cancelación diferida e historial de pagos de suscripción
-- 1. suscripcion_cancelada: distingue "cancelada pero activa hasta que venza el período pagado"
--    de "activa y se renueva automáticamente" — suscripcion_activa por sí sola ya no alcanza.
-- 2. suscripcion_charged_quantity: último summarized.charged_quantity conocido del preapproval,
--    para detectar cobros nuevos de MercadoPago (renovaciones) desde el cron de sincronización.

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS suscripcion_cancelada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suscripcion_charged_quantity INTEGER NOT NULL DEFAULT 0;
