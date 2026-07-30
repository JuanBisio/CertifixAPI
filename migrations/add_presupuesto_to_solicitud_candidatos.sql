-- SOL-08: presupuesto opcional y visible por candidato en modo programado.
-- Sigue sin ser vinculante ni bloquea nada (el precio final se sigue acordando
-- por chat, ver sección 2.5 del ROADMAP) — es solo una referencia que el
-- cliente puede comparar entre los hasta 3 candidatos, que no se ven entre sí.

ALTER TABLE public.solicitud_candidatos
  ADD COLUMN IF NOT EXISTS presupuesto NUMERIC(10, 2) CHECK (presupuesto IS NULL OR presupuesto >= 0);

-- CREATE OR REPLACE no alcanza acá: agregar un parámetro nuevo cambia la firma
-- de la función (postularse_a_solicitud(uuid,uuid) -> (uuid,uuid,numeric)),
-- lo que crearía un overload en vez de reemplazarla y dejaría ambigua
-- cualquier llamada de PostgREST con los 2 argumentos originales.
DROP FUNCTION IF EXISTS public.postularse_a_solicitud(UUID, UUID);

CREATE FUNCTION public.postularse_a_solicitud(
  p_solicitud_id UUID,
  p_prestador_id UUID,
  p_presupuesto NUMERIC DEFAULT NULL
)
RETURNS public.solicitud_candidatos
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated_id UUID;
  v_row public.solicitud_candidatos;
BEGIN
  UPDATE public.solicitudes_trabajo
  SET candidatos_count = candidatos_count + 1
  WHERE id = p_solicitud_id
    AND estado = 'buscando'
    AND urgencia = 'programado'
    AND candidatos_count < 3
    AND (postulacion_deadline_at IS NULL OR postulacion_deadline_at > NOW())
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RAISE EXCEPTION 'cupo_completo_o_no_disponible' USING ERRCODE = 'P0001';
  END IF;

  BEGIN
    INSERT INTO public.solicitud_candidatos (solicitud_id, prestador_id, estado, presupuesto)
    VALUES (p_solicitud_id, p_prestador_id, 'postulado', p_presupuesto)
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.solicitudes_trabajo
    SET candidatos_count = candidatos_count - 1
    WHERE id = p_solicitud_id;
    RAISE EXCEPTION 'ya_postulado' USING ERRCODE = 'P0002';
  END;

  RETURN v_row;
END;
$$;
