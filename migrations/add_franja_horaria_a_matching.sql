-- HOR-02 (docs/ROADMAP.md sección 3.1): cruzar la franja horaria solicitada
-- (solicitudes_trabajo.franjas_horarias, modo programado) contra la
-- disponibilidad declarada por el prestador (perfiles_prestadores.
-- franjas_horarias, jsonb {desde,hasta} en HH:mm, ver CreatePrestadorDto) —
-- el dato ya existía de las dos puntas, el RPC de matching no lo usaba.
--
-- Rangos horarios de cada franja: mismos límites que
-- certifix_mobile/react_native_space/lib/constants.ts::FRANJA_HORARIA_RANGOS
-- (los que ya se le muestran al cliente al elegir franja) —
-- mañana 08–13, tarde 13–18, noche 18–22.
--
-- Se agrega p_franjas_horarias TEXT[] DEFAULT NULL al final: NULL o array
-- vacío no filtra nada (compatibilidad con el modo urgente, que no manda
-- franja, y con cualquier caller viejo que no pase el parámetro nuevo).
-- Un prestador sin franjas_horarias cargada (fila legacy pre-HOR-01) tampoco
-- se filtra — se lo trata como "sin restricción horaria conocida" en vez de
-- excluirlo por un dato faltante.
--
-- Se hace DROP + CREATE (no CREATE OR REPLACE) porque agregar un parámetro
-- cambia la firma expuesta a PostgREST — mismo criterio ya documentado en
-- ROADMAP.md sección 3.4 para postularse_a_solicitud (CREATE OR REPLACE
-- directo hubiera dejado un overload ambiguo).
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

-- Sin esto, recrear la función deja el WARN de Advisors
-- function_search_path_mutable (la función original, de v1_sprint1_schema.sql,
-- nunca lo tuvo fijo — se corrige de paso al tocarla).
ALTER FUNCTION get_prestadores_para_solicitud(TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT[])
  SET search_path = public, pg_temp;
