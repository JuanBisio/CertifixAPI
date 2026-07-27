-- Migration: Add resolution tracking fields to disputas
-- Permite al panel admin persistir el descargo del prestador y la nota interna
-- de resolución al cerrar una disputa (usado por el detalle de disputa del admin_dashboard)

ALTER TABLE disputas
ADD COLUMN IF NOT EXISTS descargo_prestador TEXT,
ADD COLUMN IF NOT EXISTS nota_resolucion TEXT,
ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
