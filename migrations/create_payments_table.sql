-- Create payments table for storing payment records
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitud_id UUID NOT NULL REFERENCES solicitudes_trabajo(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount NUMERIC(10,2) NOT NULL,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  provider_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  payment_method TEXT,
  provider_transaction_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups by solicitud
CREATE INDEX IF NOT EXISTS idx_payments_solicitud_id ON payments(solicitud_id);

-- Index for faster lookups by transaction ID (webhook processing)
CREATE INDEX IF NOT EXISTS idx_payments_provider_transaction_id ON payments(provider_transaction_id);

-- RLS Policies
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Users can read their own payments
CREATE POLICY "Users can view own payments"
ON payments FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert payments for themselves
CREATE POLICY "Users can insert own payments"
ON payments FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Service role can update payments (for webhook processing)
CREATE POLICY "Service role can update payments"
ON payments FOR UPDATE
USING (true);

COMMENT ON TABLE payments IS 'Stores payment records for solicitudes';
