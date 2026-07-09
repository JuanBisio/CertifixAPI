-- Agrega el valor 'en_camino' al enum estado_trabajo
-- Permite que el prestador informe que ya va hacia el domicilio del cliente
ALTER TYPE estado_trabajo ADD VALUE IF NOT EXISTS 'en_camino';
