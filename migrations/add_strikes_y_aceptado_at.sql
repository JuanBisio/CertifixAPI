-- CAN-02/03/04: cancelación con consecuencias (cliente y prestador pueden
-- cancelar en estado 'aceptado'; según urgencia/tiempo transcurrido, suma un
-- strike; al acumular 3 strikes se suspende la cuenta).

-- `strikes_count`/`suspendido` viven en `perfiles` (no en `perfiles_prestadores`)
-- porque la penalización aplica tanto a clientes como a prestadores.
ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS strikes_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suspendido BOOLEAN NOT NULL DEFAULT false;

-- Necesario para calcular la ventana de 12hs de CAN-02: no existía ningún
-- timestamp de la transición a 'aceptado' hasta ahora.
ALTER TABLE solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS aceptado_at TIMESTAMPTZ;

-- RPC atómica: incrementa el contador de strikes de un perfil y, al llegar a
-- 3, marca la cuenta como suspendida en la misma operación. Devuelve el
-- contador y el flag resultantes para que el backend pueda reaccionar (avisar
-- al usuario) sin una consulta extra. Mismo patrón que
-- increment_trabajos_gratis_usados (add_trabajos_gratis_to_prestadores.sql).
CREATE OR REPLACE FUNCTION increment_strikes(p_perfil_id UUID)
RETURNS TABLE(strikes_count INTEGER, suspendido BOOLEAN) AS $$
BEGIN
  RETURN QUERY
  UPDATE perfiles
  SET
    strikes_count = perfiles.strikes_count + 1,
    suspendido = (perfiles.strikes_count + 1) >= 3
  WHERE id = p_perfil_id
  RETURNING perfiles.strikes_count, perfiles.suspendido;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;

-- Hardening: es SECURITY DEFINER, solo el backend (service_role) debe poder
-- invocarla — nunca directo vía REST por anon/authenticated. PostgreSQL otorga
-- EXECUTE a PUBLIC automáticamente al crear cualquier función — sin este REVOKE
-- explícito, anon/authenticated lo heredan igual pese a los REVOKE por rol de
-- abajo (verificado: increment_trabajos_gratis_usados, que sirvió de patrón acá,
-- no tiene esta línea pero tampoco carga PUBLIC en su ACL — probablemente por
-- una config previa del proyecto que no aplica de forma confiable a funciones
-- nuevas; no depender de eso y revocar PUBLIC explícitamente siempre).
REVOKE EXECUTE ON FUNCTION increment_strikes(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_strikes(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_strikes(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_strikes(UUID) TO service_role;
