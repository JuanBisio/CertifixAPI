-- Migration: señales explícitas de rechazo de verificación y baja de cuenta
-- para perfiles_prestadores.
--
-- Hasta ahora sólo existía esta_verificado (boolean), que no distingue
-- "nunca revisado" (pendiente) de "revisado y rechazado". Tampoco existía
-- ningún concepto de baja definitiva de cuenta (disponible es temporal/
-- toggleable por inactividad, suscripcion_activa es de facturación —
-- ninguna de las dos es una baja). Estas dos columnas le dan a
-- DocumentosVerificacionCleanupService una señal confiable de cuándo pasó
-- cada evento, para aplicar la política de retención de documentos de
-- identidad (30 días tras rechazo, 90 días tras baja).

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS verificacion_rechazada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cuenta_baja_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_prestadores_verificacion_rechazada_at
  ON perfiles_prestadores (verificacion_rechazada_at)
  WHERE verificacion_rechazada_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prestadores_cuenta_baja_at
  ON perfiles_prestadores (cuenta_baja_at)
  WHERE cuenta_baja_at IS NOT NULL;
