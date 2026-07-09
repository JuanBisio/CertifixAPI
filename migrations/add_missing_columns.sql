-- CertiFix — Columnas faltantes detectadas en testing E2E (2026-06-03)
-- Ejecutar en Supabase SQL Editor

-- 1. Agregar zona_nombre a perfiles_prestadores
ALTER TABLE perfiles_prestadores
  ADD COLUMN IF NOT EXISTS zona_nombre TEXT;

-- 2. Asegurar expo_push_tokens con constraint UNIQUE (D-14 del análisis)
CREATE TABLE IF NOT EXISTS expo_push_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE expo_push_tokens
  DROP CONSTRAINT IF EXISTS expo_push_tokens_token_key;

ALTER TABLE expo_push_tokens
  ADD CONSTRAINT expo_push_tokens_token_key UNIQUE (token);
