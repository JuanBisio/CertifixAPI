-- Migration: Create users_payment_methods table
-- Stores saved payment methods (cards) for users via MercadoPago Customer API

CREATE TABLE IF NOT EXISTS users_payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- MercadoPago Customer & Card references
    mp_customer_id TEXT NOT NULL,          -- MercadoPago customer ID
    mp_card_id TEXT NOT NULL UNIQUE,       -- MercadoPago card ID
    
    -- Card display info (masked)
    card_last_four TEXT NOT NULL,          -- Last 4 digits for display
    card_brand TEXT NOT NULL,              -- visa, master, amex, etc.
    card_expiry_month INTEGER,             -- Expiration month
    card_expiry_year INTEGER,              -- Expiration year
    cardholder_name TEXT,                  -- Name on card
    
    -- Metadata
    is_default BOOLEAN DEFAULT FALSE,      -- Default payment method
    is_active BOOLEAN DEFAULT TRUE,        -- Soft delete flag
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_payment_methods_user ON users_payment_methods(user_id);
CREATE INDEX idx_payment_methods_customer ON users_payment_methods(mp_customer_id);

-- RLS Policies
ALTER TABLE users_payment_methods ENABLE ROW LEVEL SECURITY;

-- Users can only see their own payment methods
CREATE POLICY "Users can view own payment methods"
    ON users_payment_methods FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own payment methods
CREATE POLICY "Users can insert own payment methods"
    ON users_payment_methods FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own payment methods
CREATE POLICY "Users can update own payment methods"
    ON users_payment_methods FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own payment methods
CREATE POLICY "Users can delete own payment methods"
    ON users_payment_methods FOR DELETE
    USING (auth.uid() = user_id);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_payment_methods_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_payment_methods_updated_at
    BEFORE UPDATE ON users_payment_methods
    FOR EACH ROW
    EXECUTE FUNCTION update_payment_methods_updated_at();
