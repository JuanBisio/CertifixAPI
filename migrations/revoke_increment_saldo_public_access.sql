-- Hallazgo (ROADMAP.md sección 3, 2026-07-26): increment_saldo quedó
-- ejecutable por anon/authenticated vía REST (confirmado con
-- has_function_privilege), mismo problema ya corregido en
-- increment_trabajos_gratis_usados y increment_strikes. Es del modelo de
-- `saldo` legacy (pago del trabajo cliente→prestador, módulo `payments` ya
-- eliminado) — ningún código del backend ni de la app móvil la llama hoy, así
-- que revocar el acceso público no rompe ningún flujo activo.
REVOKE EXECUTE ON FUNCTION increment_saldo(UUID, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION increment_saldo(UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION increment_saldo(UUID, NUMERIC) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_saldo(UUID, NUMERIC) TO service_role;
