-- CAL-02: subcategorías opcionales de calificación (cliente → prestador).
-- Todas nullable: complementan la puntuación principal (obligatoria), no la reemplazan.

ALTER TABLE public.calificaciones
  ADD COLUMN IF NOT EXISTS comunicacion INTEGER CHECK (comunicacion BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS puntualidad  INTEGER CHECK (puntualidad  BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS atencion     INTEGER CHECK (atencion     BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS eficiencia   INTEGER CHECK (eficiencia   BETWEEN 1 AND 5);
