-- Modo PROGRAMADO: hasta 3 prestadores candidatos por solicitud.
-- Sin RLS: se accede solo vía el backend NestJS con el cliente autenticado
-- (mismo patrón que solicitudes_trabajo, que tampoco tiene RLS propio).

CREATE TABLE IF NOT EXISTS public.solicitud_candidatos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id  UUID NOT NULL REFERENCES public.solicitudes_trabajo(id) ON DELETE CASCADE,
  prestador_id  UUID NOT NULL REFERENCES public.perfiles_prestadores(id) ON DELETE CASCADE,
  estado        TEXT NOT NULL DEFAULT 'postulado'
                  CHECK (estado IN ('postulado', 'elegido', 'no_elegido')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at    TIMESTAMPTZ,
  UNIQUE (solicitud_id, prestador_id)
);

CREATE INDEX IF NOT EXISTS idx_solicitud_candidatos_solicitud ON public.solicitud_candidatos (solicitud_id);
CREATE INDEX IF NOT EXISTS idx_solicitud_candidatos_prestador ON public.solicitud_candidatos (prestador_id);
