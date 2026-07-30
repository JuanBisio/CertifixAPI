-- HOR-03: selección múltiple de franja horaria preferida al crear la solicitud
-- (antes: una sola franja_horaria TEXT). El matching todavía no cruza esto
-- contra la disponibilidad del prestador (HOR-02, sigue pendiente) — este
-- cambio solo amplía qué puede guardar/mostrar el cliente al crear el pedido.

ALTER TABLE public.solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS franjas_horarias TEXT[];

-- Backfill: las solicitudes existentes con una única franja pasan a un array de 1 elemento.
UPDATE public.solicitudes_trabajo
SET franjas_horarias = ARRAY[franja_horaria]
WHERE franja_horaria IS NOT NULL AND franjas_horarias IS NULL;

ALTER TABLE public.solicitudes_trabajo
  DROP COLUMN IF EXISTS franja_horaria;

ALTER TABLE public.solicitudes_trabajo
  ADD CONSTRAINT franjas_horarias_valid_values CHECK (
    franjas_horarias IS NULL OR franjas_horarias <@ ARRAY['manana', 'tarde', 'noche']::TEXT[]
  );
