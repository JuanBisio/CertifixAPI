-- SOL-04 (docs/ROADMAP.md sección 3.13): radio de matching ADAPTATIVO.
--
-- Hasta ahora el alcance de una solicitud era el `radio_km` que declaró cada
-- prestador (default 10, v1_sprint1_schema.sql:40), aplicado tal cual con
-- ST_DWithin dentro de get_prestadores_para_solicitud: un solo pinchazo, a
-- todos los prestadores del rubro que tuvieran la solicitud dentro de SU radio.
-- Si no había nadie, la solicitud moría esperando el timeout.
--
-- Ahora la búsqueda avanza en rondas de radio creciente (10 → 20 → 40 → 80 km,
-- ver src/solicitudes/matching-rondas.ts, que es la fuente de verdad de la
-- escalera). El motor de rondas vive en solicitudes-timeout.service.ts (el
-- @Cron que ya corre cada 2 minutos), NO en timers en memoria.
--
-- Reglas de radio (decisiones de producto confirmadas 2026-09-06):
--   * rondas 1..N-1  → radio efectivo = LEAST(radio_ronda, pp.radio_km):
--     el radio de la ronda solo ACHICA, nunca molesta a un prestador fuera de
--     la zona que él mismo declaró.
--   * ronda N (rescate) → radio efectivo = radio_ronda, ignorando pp.radio_km:
--     último intento antes de que la solicitud quede sin nadie.
--   * p_radio_km NULL → comportamiento viejo (pp.radio_km puro), para que
--     cualquier caller que no pase el parámetro nuevo siga funcionando igual.
--
-- Ídem HOR-02: se hace DROP + CREATE (no CREATE OR REPLACE) porque agregar
-- parámetros cambia la firma expuesta a PostgREST y dejaría un overload
-- ambiguo.

-- ─── 1. Estado de la ronda, en la solicitud ──────────────────────────────────

ALTER TABLE public.solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS ronda_matching INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS ronda_matching_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN public.solicitudes_trabajo.ronda_matching IS
  'SOL-04: ronda de matching actual (1..N). El radio de cada ronda vive en src/solicitudes/matching-rondas.ts.';
COMMENT ON COLUMN public.solicitudes_trabajo.ronda_matching_at IS
  'SOL-04: cuándo se disparó la ronda actual. El cron mide el intervalo contra esto.';

-- Las solicitudes que ya estaban `buscando` al aplicar esta migración quedan
-- en la última ronda: no queremos que la escalera arranque de cero sobre datos
-- viejos y les mande pushes nuevos a los 20/40/80 km retroactivamente.
UPDATE public.solicitudes_trabajo
SET ronda_matching = 4
WHERE estado = 'buscando';

-- ─── 2. A quién ya le pinchamos, para no re-notificar ────────────────────────
--
-- Sin esto, cada ronda le volvería a mandar push al mismo prestador cercano
-- (el radio crece, así que la ronda N siempre contiene a los de la N-1).
-- No alcanza con "notificar solo el anillo entre el radio viejo y el nuevo":
-- un prestador con radio_km chico puede estar dentro del anillo interno y aun
-- así no haber sido notificado nunca (LEAST() lo dejó afuera en su momento).
CREATE TABLE IF NOT EXISTS public.solicitud_notificaciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id  UUID NOT NULL REFERENCES public.solicitudes_trabajo(id) ON DELETE CASCADE,
  prestador_id  UUID NOT NULL REFERENCES public.perfiles_prestadores(id) ON DELETE CASCADE,
  ronda         INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (solicitud_id, prestador_id)
);

CREATE INDEX IF NOT EXISTS solicitud_notificaciones_solicitud_idx
  ON public.solicitud_notificaciones (solicitud_id);

-- Bookkeeping interno del backend: se escribe y se lee siempre con el service
-- client. RLS habilitado y SIN policies (mismo criterio ya usado para
-- `postulaciones` en enable_rls_8_tables.sql) → inaccesible para anon y
-- authenticated, accesible solo para service_role.
ALTER TABLE public.solicitud_notificaciones ENABLE ROW LEVEL SECURITY;

-- ─── 3. RPC de matching con radio de ronda ───────────────────────────────────

DROP FUNCTION IF EXISTS get_prestadores_para_solicitud(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[]);

CREATE FUNCTION get_prestadores_para_solicitud(
  p_rubro_id TEXT,
  p_lon DOUBLE PRECISION,
  p_lat DOUBLE PRECISION,
  p_franjas_horarias TEXT[] DEFAULT NULL,
  p_radio_km DOUBLE PRECISION DEFAULT NULL,
  p_ignorar_radio_prestador BOOLEAN DEFAULT FALSE,
  p_excluir_prestadores UUID[] DEFAULT NULL
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
    -- Ya notificados en rondas anteriores: no se les vuelve a pinchar.
    AND (
      p_excluir_prestadores IS NULL
      OR array_length(p_excluir_prestadores, 1) IS NULL
      OR NOT (pp.id = ANY(p_excluir_prestadores))
    )
    AND ST_DWithin(
      pp.ubicacion_base::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
      (
        CASE
          -- Caller viejo (sin radio de ronda): comportamiento original.
          WHEN p_radio_km IS NULL THEN COALESCE(pp.radio_km, 10)::DOUBLE PRECISION
          -- Ronda de rescate: el radio de la ronda pisa al del prestador.
          WHEN p_ignorar_radio_prestador THEN p_radio_km
          -- Rondas normales: el radio de la ronda solo achica.
          ELSE LEAST(p_radio_km, COALESCE(pp.radio_km, 10)::DOUBLE PRECISION)
        END
      ) * 1000.0
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

-- OBLIGATORIO y fácil de perder al recrear la función: PostGIS vive en el
-- schema `extensions` en Supabase, no en `public`. Sin `extensions` acá, TODA
-- llamada al RPC falla con `type "geography" does not exist` y el matching
-- geográfico se cae al fallback en silencio — esa fue la causa 2 de la
-- sección 3.11 del ROADMAP, que tuvo el matching roto casi 2 días.
ALTER FUNCTION get_prestadores_para_solicitud(
  TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[], DOUBLE PRECISION, BOOLEAN, UUID[]
) SET search_path = public, extensions, pg_temp;
