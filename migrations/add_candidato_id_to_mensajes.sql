-- Chat multi-candidato: durante el modo PROGRAMADO puede haber hasta 3
-- prestadores candidatos chateando en paralelo con el cliente, ninguno de
-- los cuales es todavía solicitudes_trabajo.prestador_id. candidato_id
-- identifica a cuál de esos hilos pertenece cada mensaje; queda NULL para
-- siempre en el chat del modo urgente (o ya post-elección), que no cambia.

ALTER TABLE public.mensajes
  ADD COLUMN IF NOT EXISTS candidato_id UUID REFERENCES public.solicitud_candidatos(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_mensajes_candidato ON public.mensajes (candidato_id);

DROP POLICY IF EXISTS "Users can view messages for their jobs" ON public.mensajes;
DROP POLICY IF EXISTS "Users can insert messages for their jobs" ON public.mensajes;

CREATE POLICY "mensajes_select" ON public.mensajes FOR SELECT
USING (
  sender_id = auth.uid()
  OR (
    candidato_id IS NULL AND EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = mensajes.solicitud_id
        AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  )
  OR (
    candidato_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.solicitud_candidatos c
      JOIN public.solicitudes_trabajo s ON s.id = c.solicitud_id
      WHERE c.id = mensajes.candidato_id
        AND (c.prestador_id = auth.uid() OR s.cliente_id = auth.uid())
    )
  )
);

CREATE POLICY "mensajes_insert" ON public.mensajes FOR INSERT
WITH CHECK (
  sender_id = auth.uid()
  AND (
    (candidato_id IS NULL AND EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = solicitud_id AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    ))
    OR
    (candidato_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.solicitud_candidatos c
      JOIN public.solicitudes_trabajo s ON s.id = c.solicitud_id
      WHERE c.id = candidato_id AND c.solicitud_id = solicitud_id
        AND (c.prestador_id = auth.uid() OR s.cliente_id = auth.uid())
    ))
  )
);

-- mark_messages_read ahora recibe el hilo (candidato_id) a marcar; p_candidato_id
-- NULL sigue marcando el hilo legacy/urgente sin tocar los hilos de candidatos.
DROP FUNCTION IF EXISTS mark_messages_read(UUID);

CREATE FUNCTION mark_messages_read(p_solicitud_id UUID, p_candidato_id UUID DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
  UPDATE public.mensajes
  SET read = true
  WHERE solicitud_id = p_solicitud_id
    AND sender_id != auth.uid()
    AND read = false
    AND candidato_id IS NOT DISTINCT FROM p_candidato_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
