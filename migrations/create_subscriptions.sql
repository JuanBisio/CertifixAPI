-- Migration: Modelo de suscripción mensual del prestador
-- Reemplaza el fee por trabajo: el prestador paga $30.000 ARS/mes para operar en la plataforma.
-- El precio del trabajo en sí se acuerda en persona y no pasa por la app.

-- 1. Estado de suscripción en el perfil del prestador
ALTER TABLE perfiles_prestadores
ADD COLUMN IF NOT EXISTS suscripcion_activa BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE perfiles_prestadores
ADD COLUMN IF NOT EXISTS suscripcion_vence_at TIMESTAMPTZ;

-- 2. Historial de pagos de suscripción
CREATE TABLE IF NOT EXISTS suscripcion_pagos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prestador_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL DEFAULT 30000,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  payment_method TEXT,
  provider_transaction_id TEXT,
  period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suscripcion_pagos_prestador ON suscripcion_pagos(prestador_id);
CREATE INDEX IF NOT EXISTS idx_suscripcion_pagos_period_end ON suscripcion_pagos(period_end);

ALTER TABLE suscripcion_pagos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Prestador ve sus propios pagos de suscripción"
ON suscripcion_pagos FOR SELECT
USING (auth.uid() = prestador_id);

CREATE POLICY "Prestador inserta sus propios pagos de suscripción"
ON suscripcion_pagos FOR INSERT
WITH CHECK (auth.uid() = prestador_id);

COMMENT ON TABLE suscripcion_pagos IS 'Historial de cobros de la suscripción mensual del prestador a CertiFix';

-- 3. Actualizar el matching de solicitudes: solo prestadores con suscripción activa
--    reciben notificaciones de nuevas solicitudes.
CREATE OR REPLACE FUNCTION get_prestadores_para_solicitud(
  p_rubro_id  UUID,
  p_lon       DOUBLE PRECISION,
  p_lat       DOUBLE PRECISION
)
RETURNS TABLE(user_id UUID) AS $$
  SELECT pp.id AS user_id
  FROM perfiles_prestadores pp
  JOIN prestador_rubros pr ON pr.prestador_id = pp.id
  WHERE pr.rubro_id = p_rubro_id
    AND pp.disponible = true
    AND pp.esta_verificado = true
    AND pp.suscripcion_activa = true
    AND pp.ubicacion_base IS NOT NULL
    AND ST_DWithin(
      pp.ubicacion_base::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
      pp.radio_km * 1000.0
    )
$$ LANGUAGE SQL STABLE;
