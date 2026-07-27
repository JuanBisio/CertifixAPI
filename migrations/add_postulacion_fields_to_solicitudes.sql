-- Modo PROGRAMADO: plazo de postulación y contador de candidatos.
-- postulacion_deadline_at reemplaza a timeout_at para urgencia='programado'
-- (timeout_at queda NULL en ese caso; el cron sigue usando timeout_at solo para 'ahora').

ALTER TABLE public.solicitudes_trabajo
  ADD COLUMN IF NOT EXISTS postulacion_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS candidatos_count INTEGER NOT NULL DEFAULT 0
    CHECK (candidatos_count >= 0 AND candidatos_count <= 3);

-- Postulación atómica a 1 de hasta 3 cupos. Análoga en espíritu al UPDATE
-- condicional que ya usa accept(), pero acá el CAS sobre el contador protege
-- además el INSERT en solicitud_candidatos: si cualquiera de los dos pasos
-- falla, toda la función revierte (transacción implícita de la función).
CREATE OR REPLACE FUNCTION public.postularse_a_solicitud(
  p_solicitud_id UUID,
  p_prestador_id UUID
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
    INSERT INTO public.solicitud_candidatos (solicitud_id, prestador_id, estado)
    VALUES (p_solicitud_id, p_prestador_id, 'postulado')
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
