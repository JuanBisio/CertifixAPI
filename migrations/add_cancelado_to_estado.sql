-- Agrega el valor 'cancelado' al enum estado_trabajo
-- Necesario para que los clientes puedan cancelar solicitudes en estado 'buscando'
ALTER TYPE estado_trabajo ADD VALUE IF NOT EXISTS 'cancelado';
