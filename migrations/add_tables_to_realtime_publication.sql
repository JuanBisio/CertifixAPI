-- Hallazgo (ROADMAP.md sección 3.3, 2026-07-27): la publicación supabase_realtime
-- estaba vacía — ninguna suscripción postgres_changes de la app entregaba eventos
-- reales, ni en solicitudes_trabajo (useSolicitudesRealtime.ts) ni en mensajes
-- (useChat.ts). El código ya esperaba estos eventos (ambos hooks solo usan
-- payload.new para disparar un refetch/mostrar el mensaje nuevo), así que el
-- REPLICA IDENTITY por default (primary key) alcanza — no hace falta FULL.
ALTER PUBLICATION supabase_realtime ADD TABLE solicitudes_trabajo, mensajes;
