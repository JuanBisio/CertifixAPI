-- Hallazgo (ROADMAP.md sección 3.3, 2026-07-27): mark_messages_read quedó
-- SECURITY DEFINER y ejecutable por anon/authenticated vía default privileges
-- de Supabase (no alcanza con revocar de PUBLIC, hay que revocarlo explícito
-- de anon/authenticated también). No es explotable hoy — con auth.uid() nulo
-- para anon, el WHERE sender_id != auth.uid() de la función nunca matchea
-- ninguna fila — pero se cierra por prolijidad, mismo patrón ya aplicado en
-- revoke_increment_saldo_public_access.sql / increment_trabajos_gratis_usados.
--
-- Firma vigente: mark_messages_read(p_solicitud_id UUID, p_candidato_id UUID
-- DEFAULT NULL) — ver migrations/add_candidato_id_to_mensajes.sql.

REVOKE EXECUTE ON FUNCTION mark_messages_read(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION mark_messages_read(UUID, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION mark_messages_read(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION mark_messages_read(UUID, UUID) TO service_role;

-- La función corre siempre bajo el JWT del usuario (getAuthenticatedClient),
-- nunca con el service_role — así que además hay que devolverle EXECUTE a
-- `authenticated` (no a anon, que no debería poder marcar nada como leído).
GRANT EXECUTE ON FUNCTION mark_messages_read(UUID, UUID) TO authenticated;

-- De paso, mismo WARN de Supabase Advisors (function_search_path_mutable)
-- que el resto de las funciones SECURITY DEFINER del proyecto ya corrige:
-- fija el search_path para que no dependa del search_path de la sesión que
-- la invoca.
ALTER FUNCTION mark_messages_read(UUID, UUID) SET search_path = public, pg_temp;
