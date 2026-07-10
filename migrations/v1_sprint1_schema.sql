-- =============================================================
-- CertiFix V1 Sprint 1 — Migration
-- Ejecutar en Supabase SQL Editor o psql
-- =============================================================

-- Asegurar que PostGIS esté habilitado (ya debería estarlo)
CREATE EXTENSION IF NOT EXISTS postgis;

-- =============================================================
-- 1. TABLA: solicitudes_trabajo — nuevos campos V1
-- =============================================================

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

-- Hacer monto opcional (V1 no usa pagos in-app)
ALTER TABLE solicitudes_trabajo
  ALTER COLUMN monto DROP NOT NULL;

-- Actualizar enum de estado para V1 (buscando → aceptado → finalizado → cerrado)
-- Nota: si el campo es TEXT, no hay que hacer nada especial.
-- Si es un tipo ENUM, ejecutar lo siguiente:
-- ALTER TYPE estado_solicitud ADD VALUE IF NOT EXISTS 'buscando';
-- (Para TEXT los valores se validan en la app, no a nivel DB en este punto)

-- =============================================================
-- 2. TABLA: perfiles_prestadores — nuevos campos V1
-- =============================================================

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

-- Índice espacial para matching por distancia
CREATE INDEX IF NOT EXISTS idx_prestadores_ubicacion_base
  ON perfiles_prestadores USING GIST (ubicacion_base);

-- Índice para auto-inactividad cron
CREATE INDEX IF NOT EXISTS idx_prestadores_ultimo_activo
  ON perfiles_prestadores (ultimo_activo_at)
  WHERE disponible = true;

-- =============================================================
-- 3. TABLA NUEVA: prestador_rubros (many-to-many)
-- =============================================================

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

-- Migrar rubro_id existente a prestador_rubros (datos previos)
INSERT INTO prestador_rubros (prestador_id, rubro_id)
  SELECT id, rubro_id
  FROM perfiles_prestadores
  WHERE rubro_id IS NOT NULL
ON CONFLICT (prestador_id, rubro_id) DO NOTHING;

-- =============================================================
-- 4. TABLA NUEVA: calificaciones (ratings V1)
-- =============================================================

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

-- =============================================================
-- 5. FUNCIÓN RPC: get_prestadores_para_solicitud
--    Retorna user_ids de prestadores que coinciden con rubro + radio PostGIS
-- =============================================================

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

-- =============================================================
-- 6. FUNCIÓN RPC: recalcular_rating_prestador
--    Recalcula el rating promedio y cantidad de trabajos completados
-- =============================================================

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

-- =============================================================
-- 7. Índice de solicitudes activas en estado buscando
-- =============================================================

CREATE INDEX IF NOT EXISTS idx_solicitudes_buscando_timeout
  ON solicitudes_trabajo (timeout_at)
  WHERE estado = 'buscando';
