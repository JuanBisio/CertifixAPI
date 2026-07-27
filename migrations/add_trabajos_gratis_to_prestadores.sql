-- Migration: Promo de lanzamiento — primeros 3 trabajos gratis por prestador
-- Permite operar sin suscripcion_activa = true hasta haber finalizado 3 trabajos.
-- DEFAULT 0 alcanza para aplicar retroactivamente a todos los prestadores existentes
-- (el ALTER TABLE backfillea el default en las filas existentes, no hace falta UPDATE aparte).

-- 1. Contador de trabajos gratis usados
ALTER TABLE perfiles_prestadores
ADD COLUMN IF NOT EXISTS trabajos_gratis_usados INTEGER NOT NULL DEFAULT 0
  CHECK (trabajos_gratis_usados >= 0);

-- 2. Matching: acceso si tiene suscripción activa O todavía le quedan créditos de promo.
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
    AND (pp.suscripcion_activa = true OR pp.trabajos_gratis_usados < 3)
    AND pp.ubicacion_base IS NOT NULL
    AND ST_DWithin(
      pp.ubicacion_base::geography,
      ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
      pp.radio_km * 1000.0
    )
$$ LANGUAGE SQL STABLE;

-- 3. Incremento atómico del contador (evita condición de carrera si el mismo prestador
--    finaliza dos solicitudes en simultáneo) — mismo patrón que increment_saldo.
CREATE OR REPLACE FUNCTION increment_trabajos_gratis_usados(p_prestador_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE perfiles_prestadores
  SET trabajos_gratis_usados = LEAST(trabajos_gratis_usados + 1, 3)
  WHERE id = p_prestador_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

-- Hardening: es SECURITY DEFINER, solo el backend (service_role) debe poder invocarla —
-- nunca directo vía REST por anon/authenticated. Supabase otorga EXECUTE a esos roles de
-- forma explícita vía default privileges (no heredado de PUBLIC), así que hay que revocarlo
-- por rol, un simple "REVOKE ... FROM PUBLIC" no alcanza.
REVOKE EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_trabajos_gratis_usados(UUID) TO service_role;
