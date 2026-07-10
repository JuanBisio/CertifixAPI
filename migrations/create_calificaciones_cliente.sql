-- Migration: Calificación mutua — el prestador también califica al cliente
-- Espejo de la tabla `calificaciones` (cliente→prestador), pero en sentido inverso.
-- El prestador puede calificar apenas marca el trabajo como 'finalizado' (no espera a 'cerrado',
-- ya que ese paso es una acción exclusiva del cliente y el prestador no tiene control sobre cuándo ocurre).

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

-- El prestador que calificó puede ver su propia calificación
CREATE POLICY "Prestador ve las calificaciones que hizo"
ON calificaciones_cliente FOR SELECT
USING (auth.uid() = prestador_id);

-- El prestador inserta su propia calificación
CREATE POLICY "Prestador inserta calificación de cliente"
ON calificaciones_cliente FOR INSERT
WITH CHECK (auth.uid() = prestador_id);

COMMENT ON TABLE calificaciones_cliente IS 'Calificación del prestador hacia el cliente al finalizar un trabajo (mutua con calificaciones cliente→prestador)';
