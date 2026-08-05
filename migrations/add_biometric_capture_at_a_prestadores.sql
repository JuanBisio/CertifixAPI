-- Migration: timestamp del "resultado del cotejo biométrico" (verificación
-- de identidad aprobada o rechazada) para perfiles_prestadores.
--
-- Cumplimiento de privacidad V1, Política de Privacidad Sección 4.3: la
-- selfie con DNI (dato biométrico) debe borrarse exactamente 48hs después
-- de completado el cotejo. Hoy el "cotejo" no es automático (no hay
-- liveness/face-match), es la decisión manual del admin en
-- AdminService.setVerificado()/rejectPrestador() — biometric_capture_at
-- se setea en esos dos puntos, nunca al momento de subir la foto, para no
-- borrar la selfie antes de que alguien la revise.
--
-- biometric_deleted_at es el registro de auditoría que exige el documento:
-- constancia de que el borrado ocurrió y cuándo, sin guardar la imagen.

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS biometric_capture_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS biometric_deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_prestadores_biometric_capture_at
  ON perfiles_prestadores (biometric_capture_at)
  WHERE biometric_capture_at IS NOT NULL;
