-- Migration: Add saldo column to perfiles_prestadores
-- Used to store available earnings for the prestador

ALTER TABLE perfiles_prestadores 
ADD COLUMN IF NOT EXISTS saldo DECIMAL(10, 2) DEFAULT 0.00;

-- Optional: Create ledger table for transaction history (future improvement)
-- CREATE TABLE IF NOT EXISTS transactions (...)
