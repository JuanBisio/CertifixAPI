-- Bug encontrado al probar enable_rls_8_tables.sql end-to-end:
-- "infinite recursion detected in policy for relation solicitudes_trabajo".
-- solicitudes_trabajo_select consultaba solicitud_candidatos, y
-- solicitud_candidatos_select consultaba de vuelta solicitudes_trabajo — ciclo.
-- Fix estandar: la direccion candidato->solicitud se resuelve con una funcion
-- SECURITY DEFINER (dueña de las tablas, por lo tanto no dispara RLS al
-- consultar solicitud_candidatos) en vez de una subquery directa dentro de la
-- policy. La otra direccion (solicitud_candidatos_select -> solicitudes_trabajo)
-- se deja como subquery normal: como solicitudes_trabajo_select ya no vuelve a
-- consultar solicitud_candidatos directamente, no hay ciclo.
CREATE OR REPLACE FUNCTION public.es_candidato_de_solicitud(p_solicitud_id uuid, p_prestador_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM solicitud_candidatos c
    WHERE c.solicitud_id = p_solicitud_id AND c.prestador_id = p_prestador_id
  );
$$;

-- El planner de Postgres no garantiza evaluar "auth.uid() IS NOT NULL AND ..."
-- de izquierda a derecha con cortocircuito real en todos los planes — anon
-- podia terminar intentando ejecutar la funcion igual y chocar con
-- "permission denied for function" en vez de simplemente ver 0 filas. La
-- funcion solo devuelve un boolean (no expone datos), y con auth.uid() NULL
-- (caso anon) el EXISTS interno siempre da false, asi que otorgarle EXECUTE
-- a anon es seguro.
REVOKE EXECUTE ON FUNCTION public.es_candidato_de_solicitud(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.es_candidato_de_solicitud(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.es_candidato_de_solicitud(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.es_candidato_de_solicitud(uuid, uuid) TO service_role;

DROP POLICY IF EXISTS "solicitudes_trabajo_select" ON solicitudes_trabajo;

CREATE POLICY "solicitudes_trabajo_select"
  ON solicitudes_trabajo FOR SELECT
  TO public
  USING (
    cliente_id = auth.uid()
    OR prestador_id = auth.uid()
    OR (
      estado = 'buscando'
      AND EXISTS (
        SELECT 1 FROM perfiles_prestadores pp
        WHERE pp.id = auth.uid() AND pp.esta_verificado = true AND pp.disponible = true
      )
    )
    OR (auth.uid() IS NOT NULL AND public.es_candidato_de_solicitud(solicitudes_trabajo.id, auth.uid()))
  );
