-- CAN-02/03/04: historial de strikes. `perfiles.strikes_count`/`suspendido`
-- (add_strikes_y_aceptado_at.sql) ya llevan el contador agregado, pero no
-- queda registro de cuándo fue cada strike ni por qué — esta tabla lo cubre
-- para poder mostrárselo al usuario (pantalla de historial de strikes).
CREATE TABLE IF NOT EXISTS strikes_historial (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id UUID NOT NULL REFERENCES perfiles(id) ON DELETE CASCADE,
  -- Nullable: hoy todo strike viene de una cancelación (ver cancel() en
  -- solicitudes.service.ts), pero si en el futuro hay otro motivo de strike
  -- sin trabajo asociado, no debe romper el insert.
  trabajo_id UUID REFERENCES solicitudes_trabajo(id) ON DELETE SET NULL,
  motivo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strikes_historial_perfil_id ON strikes_historial(perfil_id);

ALTER TABLE strikes_historial ENABLE ROW LEVEL SECURITY;

-- Solo lectura del propio historial. Sin política de insert/update/delete
-- para authenticated/anon: la única escritura la hace el backend con el
-- service client (bypass RLS), igual que el resto de tablas de auditoría.
CREATE POLICY "Usuarios ven su propio historial de strikes"
  ON strikes_historial FOR SELECT
  USING (perfil_id = auth.uid());

-- Hardening: sin policies de insert/update/delete, authenticated/anon no
-- pueden escribir vía RLS por default-deny, pero lo dejamos explícito para
-- que quede documentada la intención (mismo criterio que
-- add_strikes_y_aceptado_at.sql aplicó a increment_strikes).
REVOKE INSERT, UPDATE, DELETE ON strikes_historial FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON strikes_historial FROM anon;
GRANT SELECT ON strikes_historial TO authenticated;
GRANT ALL ON strikes_historial TO service_role;
