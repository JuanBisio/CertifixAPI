-- F1 (HIGH, claude-security 2026-08-11): Realtime entrega la fila cruda de
-- solicitudes_trabajo a cualquier prestador verificado y disponible para
-- trabajos 'buscando' (RLS es a nivel de fila, no de columna) — incluyendo
-- direccion_exacta/ubicacion_real, salteándose por completo la sanitización
-- que sanitizeLocation() aplica solo en la capa de aplicación
-- (src/solicitudes/solicitudes.service.ts). Ver
-- CLAUDE-SECURITY-20260811-154213/CLAUDE-SECURITY-RESULTS.md.
--
-- Opción (b) del reporte: mover las columnas sensibles a una tabla aparte con
-- su propia RLS restringida al cliente dueño y al prestador asignado, y dejar
-- en solicitudes_trabajo solo ubicacion_difusa (±500m, segura de publicar
-- completa por Realtime). A diferencia de la opción (a) (sacar
-- solicitudes_trabajo de la publicación realtime), esto mantiene la tabla en
-- supabase_realtime por si en el futuro algún consumidor necesita leer el
-- contenido del evento en vez de solo usarlo como disparador de refetch.
--
-- Esta tabla nueva NUNCA se agrega a la publicación supabase_realtime.

CREATE TABLE IF NOT EXISTS solicitudes_ubicacion_privada (
  solicitud_id     UUID PRIMARY KEY REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  direccion_exacta TEXT,
  ubicacion_real   GEOMETRY(Point, 4326),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill: preservar la ubicación exacta de las solicitudes ya existentes
-- antes de borrar las columnas de solicitudes_trabajo.
INSERT INTO solicitudes_ubicacion_privada (solicitud_id, direccion_exacta, ubicacion_real)
SELECT id, direccion_exacta, ubicacion_real
FROM solicitudes_trabajo
WHERE direccion_exacta IS NOT NULL OR ubicacion_real IS NOT NULL
ON CONFLICT (solicitud_id) DO NOTHING;

ALTER TABLE solicitudes_ubicacion_privada ENABLE ROW LEVEL SECURITY;

-- Mismo patrón que las policies de mensajes/solicitud_candidatos: TO public,
-- gateado por auth.uid() — anon (JWT ausente, auth.uid() IS NULL) queda
-- excluido sin necesidad de una policy separada por rol.
CREATE POLICY "solicitudes_ubicacion_privada_select"
  ON solicitudes_ubicacion_privada FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo st
      WHERE st.id = solicitud_id
        AND (st.cliente_id = auth.uid() OR st.prestador_id = auth.uid())
    )
  );

-- Solo el cliente dueño de la solicitud recién creada puede insertar su
-- ubicación privada (create() en solicitudes.service.ts, mismo request que
-- crea la fila padre, con el client autenticado del propio cliente).
CREATE POLICY "solicitudes_ubicacion_privada_insert"
  ON solicitudes_ubicacion_privada FOR INSERT
  TO public
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM solicitudes_trabajo st
      WHERE st.id = solicitud_id AND st.cliente_id = auth.uid()
    )
  );

-- Sacar las columnas sensibles de la tabla publicada por Realtime. A partir de
-- acá, un evento de postgres_changes sobre solicitudes_trabajo nunca puede
-- contener la dirección exacta, sin importar qué RLS tenga la tabla.
ALTER TABLE solicitudes_trabajo DROP COLUMN direccion_exacta;
ALTER TABLE solicitudes_trabajo DROP COLUMN ubicacion_real;
