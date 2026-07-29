-- Migration: Add admin tracking fields to suscripcion_pagos
-- Permite al panel admin registrar pagos de suscripción cobrados fuera de MercadoPago
-- (efectivo, transferencia, etc.) dejando rastro de qué admin lo cargó y por qué.
-- registrado_por_admin_email IS NOT NULL es la señal de que el pago fue manual.

ALTER TABLE suscripcion_pagos
ADD COLUMN IF NOT EXISTS registrado_por_admin_email TEXT,
ADD COLUMN IF NOT EXISTS nota_admin TEXT;
