-- Create messages table for real-time chat
CREATE TABLE IF NOT EXISTS public.mensajes (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  solicitud_id UUID REFERENCES public.solicitudes_trabajo(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.mensajes ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view messages for their jobs" 
  ON public.mensajes FOR SELECT 
  USING (
    sender_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = mensajes.solicitud_id
      AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

CREATE POLICY "Users can insert messages for their jobs" 
  ON public.mensajes FOR INSERT 
  WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.solicitudes_trabajo s
      WHERE s.id = solicitud_id
      AND (s.cliente_id = auth.uid() OR s.prestador_id = auth.uid())
    )
  );

-- Function to mark messages as read
CREATE OR REPLACE FUNCTION mark_messages_read(p_solicitud_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.mensajes
  SET read = true
  WHERE solicitud_id = p_solicitud_id
  AND sender_id != auth.uid()
  AND read = false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
