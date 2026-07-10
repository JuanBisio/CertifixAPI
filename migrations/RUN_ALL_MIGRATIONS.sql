-- =============================================================
-- CertiFix V1 — Script de migraciones consolidado
-- Ejecutar en Supabase SQL Editor (en orden)
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 1: Sprint 1 — Schema principal V1
-- ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS postgis;

-- solicitudes_trabajo — nuevos campos V1
ALTER TABLE solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS fotos_urls        TEXT[],
  ADD COLUMN IF NOT EXISTS tipo_tecnico      TEXT NOT NULL DEFAULT 'estandar'
    CHECK (tipo_tecnico IN ('estandar', 'premium')),
  ADD COLUMN IF NOT EXISTS urgencia          TEXT NOT NULL DEFAULT 'ahora'
    CHECK (urgencia IN ('ahora', 'programado')),
  ADD COLUMN IF NOT EXISTS franja_horaria    TEXT
    CHECK (franja_horaria IN ('manana', 'tarde', 'noche')),
  ADD COLUMN IF NOT EXISTS fecha_preferida   DATE,
  ADD COLUMN IF NOT EXISTS timeout_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timeout_notificado_at TIMESTAMPTZ;

ALTER TABLE solicitudes_trabajo
  ALTER COLUMN monto DROP NOT NULL;

-- perfiles_prestadores — nuevos campos V1
ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS radio_km              INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS foto_perfil_url       TEXT,
  ADD COLUMN IF NOT EXISTS dni_frente_url        TEXT,
  ADD COLUMN IF NOT EXISTS dni_dorso_url         TEXT,
  ADD COLUMN IF NOT EXISTS selfie_dni_url        TEXT,
  ADD COLUMN IF NOT EXISTS matricula_url         TEXT,
  ADD COLUMN IF NOT EXISTS tipo_verificacion     TEXT NOT NULL DEFAULT 'estandar'
    CHECK (tipo_verificacion IN ('estandar', 'premium')),
  ADD COLUMN IF NOT EXISTS franjas_horarias      JSONB NOT NULL DEFAULT '{"manana": false, "tarde": false, "noche": false}'::jsonb,
  ADD COLUMN IF NOT EXISTS ultimo_activo_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ubicacion_base        GEOMETRY(Point, 4326),
  ADD COLUMN IF NOT EXISTS rating                DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS trabajos_completados  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_prestadores_ubicacion_base
  ON perfiles_prestadores USING GIST (ubicacion_base);

CREATE INDEX IF NOT EXISTS idx_prestadores_ultimo_activo
  ON perfiles_prestadores (ultimo_activo_at)
  WHERE disponible = true;

-- prestador_rubros (many-to-many)
-- Nota: rubro_id es TEXT porque rubros.id es TEXT en este proyecto
CREATE TABLE IF NOT EXISTS prestador_rubros (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prestador_id  UUID NOT NULL REFERENCES perfiles_prestadores(id) ON DELETE CASCADE,
  rubro_id      TEXT NOT NULL REFERENCES rubros(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prestador_id, rubro_id)
);

CREATE INDEX IF NOT EXISTS idx_prestador_rubros_prestador
  ON prestador_rubros (prestador_id);

CREATE INDEX IF NOT EXISTS idx_prestador_rubros_rubro
  ON prestador_rubros (rubro_id);

-- Migrar rubro_id existente a prestador_rubros
INSERT INTO prestador_rubros (prestador_id, rubro_id)
  SELECT id, rubro_id
  FROM perfiles_prestadores
  WHERE rubro_id IS NOT NULL
ON CONFLICT (prestador_id, rubro_id) DO NOTHING;

-- calificaciones
CREATE TABLE IF NOT EXISTS calificaciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id  UUID NOT NULL REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES perfiles(id),
  prestador_id  UUID NOT NULL REFERENCES perfiles(id),
  puntuacion    INTEGER NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
  comentario    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (solicitud_id)
);

CREATE INDEX IF NOT EXISTS idx_calificaciones_prestador
  ON calificaciones (prestador_id);

-- RPC: get_prestadores_para_solicitud
CREATE OR REPLACE FUNCTION get_prestadores_para_solicitud(
  p_rubro_id  TEXT,
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
    AND pp.ubicacion_base IS NOT NULL
    AND ST_DWithin(
      pp.ubicacion_base::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
      pp.radio_km * 1000.0
    )
$$ LANGUAGE SQL STABLE;

-- RPC: recalcular_rating_prestador
CREATE OR REPLACE FUNCTION recalcular_rating_prestador(p_prestador_id UUID)
RETURNS VOID AS $$
  UPDATE perfiles_prestadores
  SET
    rating = COALESCE((
      SELECT ROUND(AVG(puntuacion)::numeric, 2)
      FROM calificaciones
      WHERE prestador_id = p_prestador_id
    ), 0.00),
    trabajos_completados = (
      SELECT COUNT(*)
      FROM calificaciones
      WHERE prestador_id = p_prestador_id
    )
  WHERE id = p_prestador_id;
$$ LANGUAGE SQL;

CREATE INDEX IF NOT EXISTS idx_solicitudes_buscando_timeout
  ON solicitudes_trabajo (timeout_at)
  WHERE estado = 'buscando';

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 2: Saldo de prestadores
-- ──────────────────────────────────────────────────────────────

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS saldo DECIMAL(10, 2) DEFAULT 0.00;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 3: RPC increment_saldo
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION increment_saldo(user_id UUID, amount DECIMAL)
RETURNS VOID AS $$
BEGIN
  UPDATE perfiles_prestadores
  SET saldo = COALESCE(saldo, 0) + amount
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 4: Mensajes (chat)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mensajes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  solicitud_id UUID REFERENCES public.solicitudes_trabajo(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.mensajes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view messages for their jobs"
  ON public.mensajes FOR SELECT
  USING (
    sender_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = mensajes.solicitud_id
      AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

CREATE POLICY "Users can insert messages for their jobs"
  ON public.mensajes FOR INSERT
  WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = solicitud_id
      AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

CREATE OR REPLACE FUNCTION mark_messages_read(p_solicitud_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.mensajes
  SET read = true
  WHERE solicitud_id = p_solicitud_id
  AND sender_id != auth.uid()
  AND read = false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 5: Tabla payments
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id UUID NOT NULL REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method TEXT,
  provider_transaction_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_solicitud_id ON payments(solicitud_id);
CREATE INDEX IF NOT EXISTS idx_payments_provider_transaction_id ON payments(provider_transaction_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payments"
  ON payments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own payments"
  ON payments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can update payments"
  ON payments FOR UPDATE
  USING (true);

-- ──────────────────────────────────────────────────────────────
-- BLOQUE 6: Tabla users_payment_methods (futuro — V2)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users_payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    mp_customer_id TEXT NOT NULL,
    mp_card_id TEXT NOT NULL UNIQUE,
    card_last_four TEXT NOT NULL,
    card_brand TEXT NOT NULL,
    card_expiry_month INTEGER,
    card_expiry_year INTEGER,
    cardholder_name TEXT,
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON users_payment_methods(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_methods_customer ON users_payment_methods(mp_customer_id);

ALTER TABLE users_payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payment methods"
    ON users_payment_methods FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own payment methods"
    ON users_payment_methods FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own payment methods"
    ON users_payment_methods FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own payment methods"
    ON users_payment_methods FOR DELETE
    USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_payment_methods_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_payment_methods_updated_at
    BEFORE UPDATE ON users_payment_methods
    FOR EACH ROW
    EXECUTE FUNCTION update_payment_methods_updated_at();

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N: Modelo de suscripción mensual del prestador
-- ──────────────────────────────────────────────────────────────

ALTER TABLE perfiles_prestadores
ADD COLUMN IF NOT EXISTS suscripcion_activa BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE perfiles_prestadores
ADD COLUMN IF NOT EXISTS suscripcion_vence_at TIMESTAMPTZ;

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

CREATE OR REPLACE FUNCTION get_prestadores_para_solicitud(
  p_rubro_id  TEXT,
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

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+1: Calificación mutua — el prestador también califica al cliente
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calificaciones_cliente (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id  UUID NOT NULL REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  cliente_id    UUID NOT NULL REFERENCES perfiles(id),
  prestador_id  UUID NOT NULL REFERENCES perfiles(id),
  puntuacion    INTEGER NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
  comentario    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (solicitud_id)
);

CREATE INDEX IF NOT EXISTS idx_calificaciones_cliente_cliente
  ON calificaciones_cliente (cliente_id);

ALTER TABLE calificaciones_cliente ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Prestador ve las calificaciones que hizo"
ON calificaciones_cliente FOR SELECT
USING (auth.uid() = prestador_id);

CREATE POLICY "Prestador inserta calificación de cliente"
ON calificaciones_cliente FOR INSERT
WITH CHECK (auth.uid() = prestador_id);

COMMENT ON TABLE calificaciones_cliente IS 'Calificación del prestador hacia el cliente al finalizar un trabajo (mutua con calificaciones cliente→prestador)';
