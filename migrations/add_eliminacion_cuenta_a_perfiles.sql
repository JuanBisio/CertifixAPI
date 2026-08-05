-- Migration: eliminación real de cuenta (self-service) para perfiles.
--
-- Cumplimiento de privacidad V1, T&C Sección 2.6 / Política Sección 14.2 +
-- requisito de App Store (Guideline 5.1.1(v)) / Google Play: la app tiene
-- que poder borrar la cuenta desde adentro, no solo desactivarla.
--
-- eliminacion_solicitada_at: seteado por AuthService al llamar
-- POST /auth/account/delete-request — arranca el plazo de 30 días
-- corridos para la supresión real de datos y bloquea el login mientras
-- tanto (no hay período de gracia/cancelación, es irreversible).
-- eliminado_at: registro de auditoría de cuándo corrió efectivamente la
-- purga (AccountDeletionCleanupService), sin guardar ningún dato personal.
--
-- No hace falta ninguna columna nueva para disociar identidad en
-- calificaciones/calificaciones_cliente: esas tablas tienen cliente_id/
-- prestador_id NOT NULL apuntando a perfiles.id sin ON DELETE CASCADE
-- (confirmado contra el schema real) — alcanza con anonimizar la fila de
-- perfiles in-place, conservando el id, para que la reseña quede
-- automáticamente disociada de la identidad.

ALTER TABLE perfiles
  ADD COLUMN IF NOT EXISTS eliminacion_solicitada_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS eliminado_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_perfiles_eliminacion_solicitada_at
  ON perfiles (eliminacion_solicitada_at)
  WHERE eliminacion_solicitada_at IS NOT NULL;
