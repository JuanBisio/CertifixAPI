-- Migration: Derecho de arrepentimiento (Ley de Defensa del Consumidor)
-- Formularios de revocación enviados por clientes (uso del servicio de
-- intermediación) o prestadores (suscripción paga), dentro de la ventana
-- legal de 10 días corridos. El efecto (baja, freno de cobro, devolución)
-- se procesa manualmente por el equipo desde el panel admin.

CREATE TABLE IF NOT EXISTS solicitudes_revocacion (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    perfil_id                   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    rol                         TEXT NOT NULL CHECK (rol IN ('cliente', 'prestador')),
    nombre                      TEXT NOT NULL,
    dato_cuenta                 TEXT NOT NULL,
    tipo_revocado               TEXT NOT NULL,
    fecha_contratacion          TIMESTAMPTZ NOT NULL,
    motivo                      TEXT,

    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    procesado                   BOOLEAN NOT NULL DEFAULT FALSE,
    procesado_at                TIMESTAMPTZ,
    procesado_por_admin_email   TEXT,
    nota_admin                  TEXT
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_revocacion_perfil_id ON solicitudes_revocacion(perfil_id);
CREATE INDEX IF NOT EXISTS idx_solicitudes_revocacion_procesado ON solicitudes_revocacion(procesado);

ALTER TABLE solicitudes_revocacion ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuario ve sus propias solicitudes de revocación"
    ON solicitudes_revocacion FOR SELECT
    USING (auth.uid() = perfil_id);

CREATE POLICY "Usuario crea su propia solicitud de revocación"
    ON solicitudes_revocacion FOR INSERT
    WITH CHECK (auth.uid() = perfil_id);

COMMENT ON TABLE solicitudes_revocacion IS
  'Formularios de derecho de arrepentimiento (Ley de Defensa del Consumidor) enviados por clientes o prestadores. nombre/dato_cuenta/tipo_revocado/fecha_contratacion se guardan como snapshot al momento del envío para preservar el registro legal.';
