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
-- (definición temprana intencionalmente eliminada: quedaban 3 copias
-- desactualizadas de esta función en este archivo, ver BLOQUE final más abajo
-- para la definición vigente — sección 3.11 de docs/ROADMAP.md)

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

-- (definición intermedia de get_prestadores_para_solicitud eliminada, ver nota arriba)

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

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+2: Resolución de disputas — panel admin
-- ──────────────────────────────────────────────────────────────

ALTER TABLE disputas
ADD COLUMN IF NOT EXISTS descargo_prestador TEXT,
ADD COLUMN IF NOT EXISTS nota_resolucion TEXT,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+2: Migrar suscripción a la API de Preapproval de MercadoPago
-- ──────────────────────────────────────────────────────────────

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT,
  ADD COLUMN IF NOT EXISTS suscripcion_card_last_four TEXT,
  ADD COLUMN IF NOT EXISTS suscripcion_card_brand TEXT;

ALTER TABLE suscripcion_pagos
  ADD COLUMN IF NOT EXISTS mp_preapproval_id TEXT;

CREATE INDEX IF NOT EXISTS idx_prestadores_mp_preapproval
  ON perfiles_prestadores(mp_preapproval_id)
  WHERE mp_preapproval_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+3: Cancelación diferida + detección de renovaciones
-- ──────────────────────────────────────────────────────────────

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS suscripcion_cancelada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS suscripcion_charged_quantity INTEGER NOT NULL DEFAULT 0;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+4: Promo de lanzamiento — primeros 3 trabajos gratis por prestador
-- ──────────────────────────────────────────────────────────────

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS trabajos_gratis_usados INTEGER NOT NULL DEFAULT 0
    CHECK (trabajos_gratis_usados >= 0);

-- Definición vigente (ver nodejs_space/migrations/add_franja_horaria_a_matching.sql):
-- incluye filtro por franja horaria y el fix de search_path de la sección 3.11
-- de docs/ROADMAP.md (sin `extensions` en el search_path, ST_DWithin fallaba
-- con "type geography does not exist" y el matching caía al fallback sin
-- filtro geográfico).
DROP FUNCTION IF EXISTS get_prestadores_para_solicitud(TEXT, DOUBLE PRECISION, DOUBLE PRECISION);

CREATE FUNCTION get_prestadores_para_solicitud(
  p_rubro_id TEXT,
  p_lon DOUBLE PRECISION,
  p_lat DOUBLE PRECISION,
  p_franjas_horarias TEXT[] DEFAULT NULL
)
RETURNS TABLE(user_id UUID)
LANGUAGE sql
STABLE
AS $$
  SELECT pp.id AS user_id
  FROM perfiles_prestadores pp
  JOIN prestador_rubros pr ON pr.prestador_id = pp.id
  WHERE pr.rubro_id = p_rubro_id
    AND pp.disponible = true
    AND pp.esta_verificado = true
    AND (pp.suscripcion_activa = true OR pp.trabajos_gratis_usados < 3)
    AND pp.ubicacion_base IS NOT NULL
    AND ST_DWithin(
      pp.ubicacion_base::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
      pp.radio_km * 1000.0
    )
    AND (
      p_franjas_horarias IS NULL
      OR array_length(p_franjas_horarias, 1) IS NULL
      OR pp.franjas_horarias IS NULL
      OR EXISTS (
        SELECT 1
        FROM unnest(p_franjas_horarias) AS franja
        WHERE (pp.franjas_horarias->>'desde') < (
                CASE franja
                  WHEN 'manana' THEN '13:00'
                  WHEN 'tarde' THEN '18:00'
                  WHEN 'noche' THEN '22:00'
                END
              )
          AND (pp.franjas_horarias->>'hasta') > (
                CASE franja
                  WHEN 'manana' THEN '08:00'
                  WHEN 'tarde' THEN '13:00'
                  WHEN 'noche' THEN '18:00'
                END
              )
      )
    )
$$;

ALTER FUNCTION get_prestadores_para_solicitud(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[])
  SET search_path = public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION increment_trabajos_gratis_usados(p_prestador_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE perfiles_prestadores
  SET trabajos_gratis_usados = LEAST(trabajos_gratis_usados + 1, 3)
  WHERE id = p_prestador_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) TO service_role;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+5: Modo PROGRAMADO — candidatos (hasta 3) y chat multi-hilo
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS solicitud_candidatos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id  UUID NOT NULL REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  prestador_id  UUID NOT NULL REFERENCES perfiles_prestadores(id) ON DELETE CASCADE,
  estado        TEXT NOT NULL DEFAULT 'postulado'
                  CHECK (estado IN ('postulado', 'elegido', 'no_elegido')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  UNIQUE (solicitud_id, prestador_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitud_candidatos_solicitud ON solicitud_candidatos (solicitud_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_candidatos_prestador ON solicitud_candidatos (prestador_id);

ALTER TABLE solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS postulacion_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS candidatos_count INTEGER NOT NULL DEFAULT 0
    CHECK (candidatos_count >= 0 AND candidatos_count <= 3);

CREATE OR REPLACE FUNCTION postularse_a_solicitud(
  p_solicitud_id UUID,
  p_prestador_id UUID
)
RETURNS solicitud_candidatos
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_id UUID;
  v_row solicitud_candidatos;
BEGIN
  UPDATE solicitudes_trabajo
  SET candidatos_count = candidatos_count + 1
  WHERE id = p_solicitud_id
    AND estado = 'buscando'
    AND urgencia = 'programado'
    AND candidatos_count < 3
    AND (postulacion_deadline_at IS NULL OR postulacion_deadline_at > NOW())
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RAISE EXCEPTION 'cupo_completo_o_no_disponible' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO solicitud_candidatos (solicitud_id, prestador_id, estado)
    VALUES (p_solicitud_id, p_prestador_id, 'postulado')
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    UPDATE solicitudes_trabajo SET candidatos_count = candidatos_count - 1 WHERE id = p_solicitud_id;
    RAISE EXCEPTION 'ya_postulado' USING ERRCODE = 'P0002';
  END;

  RETURN v_row;
END;
$$;

ALTER TABLE mensajes
  ADD COLUMN IF NOT EXISTS candidato_id UUID REFERENCES solicitud_candidatos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_mensajes_candidato ON mensajes (candidato_id);

DROP POLICY IF EXISTS "Users can view messages for their jobs" ON mensajes;
DROP POLICY IF EXISTS "Users can insert messages for their jobs" ON mensajes;

CREATE POLICY "mensajes_select" ON mensajes FOR SELECT
USING (
  sender_id = auth.uid()
  OR (
    candidato_id IS NULL AND EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = mensajes.solicitud_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  )
  OR (
    candidato_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM solicitud_candidatos c
      JOIN solicitudes_trabajo s ON s.id = c.solicitud_id
      WHERE c.id = mensajes.candidato_id
        AND (c.prestador_id = auth.uid() OR s.cliente_id = auth.uid())
    )
  )
);

CREATE POLICY "mensajes_insert" ON mensajes FOR INSERT
WITH CHECK (
  sender_id = auth.uid()
  AND (
    (candidato_id IS NULL AND EXISTS (
      SELECT 1 FROM solicitudes_trabajo s
      WHERE s.id = solicitud_id AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    ))
    OR
    (candidato_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM solicitud_candidatos c
      JOIN solicitudes_trabajo s ON s.id = c.solicitud_id
      WHERE c.id = candidato_id AND c.solicitud_id = solicitud_id
        AND (c.prestador_id = auth.uid() OR s.cliente_id = auth.uid())
    ))
  )
);

DROP FUNCTION IF EXISTS mark_messages_read(UUID);

CREATE FUNCTION mark_messages_read(p_solicitud_id UUID, p_candidato_id UUID DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
  UPDATE mensajes
  SET read = true
  WHERE solicitud_id = p_solicitud_id
    AND sender_id != auth.uid()
    AND read = false
    AND candidato_id IS NOT DISTINCT FROM p_candidato_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+6: CAL-02 — subcategorías opcionales de calificación (cliente → prestador)
-- ──────────────────────────────────────────────────────────────

ALTER TABLE calificaciones
  ADD COLUMN IF NOT EXISTS comunicacion INTEGER CHECK (comunicacion BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS puntualidad  INTEGER CHECK (puntualidad  BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS atencion     INTEGER CHECK (atencion     BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS eficiencia   INTEGER CHECK (eficiencia   BETWEEN 1 AND 5);

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+6: Direcciones guardadas y reutilizables del cliente (UBI-02)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS direcciones_guardadas (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    alias         TEXT NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 40),
    direccion     TEXT NOT NULL,
    zona_nombre   TEXT NOT NULL,
    lat           DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon           DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
    place_id      TEXT,

    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_direcciones_guardadas_user ON direcciones_guardadas(user_id);
CREATE INDEX IF NOT EXISTS idx_direcciones_guardadas_user_activas
  ON direcciones_guardadas(user_id) WHERE is_active = true;

ALTER TABLE direcciones_guardadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Cliente ve sus propias direcciones guardadas"
    ON direcciones_guardadas FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Cliente inserta sus propias direcciones guardadas"
    ON direcciones_guardadas FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Cliente actualiza sus propias direcciones guardadas"
    ON direcciones_guardadas FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Cliente elimina sus propias direcciones guardadas"
    ON direcciones_guardadas FOR DELETE
    USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_direcciones_guardadas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = public, pg_temp;

CREATE TRIGGER trigger_direcciones_guardadas_updated_at
    BEFORE UPDATE ON direcciones_guardadas
    FOR EACH ROW
    EXECUTE FUNCTION update_direcciones_guardadas_updated_at();

COMMENT ON TABLE direcciones_guardadas IS
  'Direcciones guardadas y reutilizables del cliente (UBI-02) — alias tipo Casa/Trabajo + coordenadas para reutilizar al crear una solicitud';

-- ──────────────────────────────────────────────────────────────
-- BLOQUE N+7: Derecho de arrepentimiento (Ley de Defensa del Consumidor)
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS solicitudes_revocacion (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    perfil_id                   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    rol                         TEXT NOT NULL CHECK (rol IN ('cliente', 'prestador')),
    nombre                      TEXT NOT NULL,
    dato_cuenta                 TEXT NOT NULL,
    tipo_revocado               TEXT NOT NULL,
    fecha_contratacion          TIMESTAMPTZ NOT NULL,
    motivo                      TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    procesado                   BOOLEAN NOT NULL DEFAULT FALSE,
    procesado_at                TIMESTAMPTZ,
    procesado_por_admin_email   TEXT,
    nota_admin                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_revocacion_perfil_id ON solicitudes_revocacion(perfil_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_revocacion_procesado ON solicitudes_revocacion(procesado);

ALTER TABLE solicitudes_revocacion ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuario ve sus propias solicitudes de revocación"
    ON solicitudes_revocacion FOR SELECT
    USING (auth.uid() = perfil_id);

CREATE POLICY "Usuario crea su propia solicitud de revocación"
    ON solicitudes_revocacion FOR INSERT
    WITH CHECK (auth.uid() = perfil_id);

COMMENT ON TABLE solicitudes_revocacion IS
  'Formularios de derecho de arrepentimiento (Ley de Defensa del Consumidor) enviados por clientes o prestadores. nombre/dato_cuenta/tipo_revocado/fecha_contratacion se guardan como snapshot al momento del envío para preservar el registro legal.';
