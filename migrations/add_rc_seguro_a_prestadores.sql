-- Migration: beneficio interno de seguro de Responsabilidad Civil (RC) del prestador.
--
-- Campo opcional que el prestador carga en su perfil (comprobante de póliza +
-- datos de la aseguradora) y que un admin revisa y verifica a mano, mismo
-- circuito manual que la matrícula profesional. rc_verificado lo tilda el
-- admin; DocumentosVerificacionCleanupService lo hace caer solo a false
-- cuando rc_vencimiento ya pasó (ver purgeRcVencidos).
--
-- No afecta el matching de solicitudes ni es visible para el cliente.

ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS rc_poliza_url TEXT,
  ADD COLUMN IF NOT EXISTS rc_aseguradora TEXT,
  ADD COLUMN IF NOT EXISTS rc_numero_poliza TEXT,
  ADD COLUMN IF NOT EXISTS rc_vencimiento DATE,
  ADD COLUMN IF NOT EXISTS rc_verificado BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_prestadores_rc_verificado_vencimiento
  ON perfiles_prestadores (rc_vencimiento)
  WHERE rc_verificado = true;
