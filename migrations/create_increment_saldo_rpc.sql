-- Function to safely increment provider balance
-- This ensures atomic updates and avoids race conditions

CREATE OR REPLACE FUNCTION increment_saldo(user_id UUID, amount DECIMAL)
RETURNS VOID AS $$
BEGIN
  UPDATE perfiles_prestadores
  SET saldo = COALESCE(saldo, 0) + amount
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
