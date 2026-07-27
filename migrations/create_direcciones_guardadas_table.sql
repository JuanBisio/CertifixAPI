-- Migration: Direcciones guardadas y reutilizables del cliente (UBI-02)
-- Permite guardar direcciones con alias (Casa, Trabajo, etc.) para reutilizarlas
-- al crear una solicitud, en vez de tipear y geocodificar desde cero cada vez.
-- Alcance: solo cliente en esta iteración (el prestador usa `ubicacion_base` en
-- perfiles_prestadores, no esta tabla).

CREATE TABLE IF NOT EXISTS direcciones_guardadas (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    alias         TEXT NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 40),
    direccion     TEXT NOT NULL,                    -- dirección formateada (Places o editada a mano)
    zona_nombre   TEXT NOT NULL,                     -- una de las 5 zonas fijas (mismo campo que solicitudes_trabajo)
    lat           DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lon           DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
    place_id      TEXT,                              -- Google Place ID, si vino de autocompletado (informativo)

    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,      -- soft delete

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_direcciones_guardadas_user ON direcciones_guardadas(user_id);
CREATE INDEX IF NOT EXISTS idx_direcciones_guardadas_user_activas
  ON direcciones_guardadas(user_id) WHERE is_active = true;

-- RLS
ALTER TABLE direcciones_guardadas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Cliente ve sus propias direcciones guardadas"
    ON direcciones_guardadas FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Cliente inserta sus propias direcciones guardadas"
    ON direcciones_guardadas FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Cliente actualiza sus propias direcciones guardadas"
    ON direcciones_guardadas FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Cliente elimina sus propias direcciones guardadas"
    ON direcciones_guardadas FOR DELETE
    USING (auth.uid() = user_id);

-- Trigger de updated_at (mismo patrón que create_payment_methods_table.sql)
CREATE OR REPLACE FUNCTION update_direcciones_guardadas_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = public, pg_temp;

CREATE TRIGGER trigger_direcciones_guardadas_updated_at
    BEFORE UPDATE ON direcciones_guardadas
    FOR EACH ROW
    EXECUTE FUNCTION update_direcciones_guardadas_updated_at();

COMMENT ON TABLE direcciones_guardadas IS
  'Direcciones guardadas y reutilizables del cliente (UBI-02) — alias tipo Casa/Trabajo + coordenadas para reutilizar al crear una solicitud';
