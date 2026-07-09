-- Tabla para almacenar los tokens de Expo Push Notifications por usuario
CREATE TABLE IF NOT EXISTS public.expo_push_tokens (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id)
);

-- RLS
ALTER TABLE public.expo_push_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Usuario puede gestionar su propio token"
  ON public.expo_push_tokens
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
