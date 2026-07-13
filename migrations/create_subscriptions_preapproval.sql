-- Migration: Migrar el cobro de suscripción a la API de Preapproval (Suscripciones) de MercadoPago
-- Reemplaza el cobro manual (Payments API + tarjeta guardada + cron) por un preapproval
-- que MercadoPago cobra automáticamente cada mes. No se toca `suscripcion_activa`/
-- `suscripcion_vence_at` (creadas en create_subscriptions.sql) — siguen siendo la fuente
-- de verdad que consume la app.

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT,
  ADD COLUMN IF NOT EXISTS suscripcion_card_last_four TEXT,
  ADD COLUMN IF NOT EXISTS suscripcion_card_brand TEXT;

ALTER TABLE suscripcion_pagos
  ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT;

CREATE INDEX IF NOT EXISTS idx_prestadores_mp_preapproval
  ON perfiles_prestadores(mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;
