-- ══════════════════════════════════════════════
--   Daftari POS — Schema v4 Migration
--   Run: psql $DATABASE_URL -f db/schema_v4.sql
-- ══════════════════════════════════════════════

-- ── Product image URL (no file uploads — URL only) ──
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;

-- ── Payment tracking fields on stores ──
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_payment_status_check;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payment_status    VARCHAR(20) DEFAULT 'unpaid'
  CHECK (payment_status IN ('paid', 'unpaid', 'overdue'));
ALTER TABLE stores ADD COLUMN IF NOT EXISTS payment_due_date  TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) DEFAULT 'basic'
  CHECK (subscription_plan IN ('basic', 'premium', 'enterprise'));

-- ══════════════════════════════════════════════
--   PAYMENTS TABLE
--   Admin records each payment manually (WhatsApp / cash).
--   No payment gateway needed — keeps it offline-friendly.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  amount      NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  plan_name   VARCHAR(50),
  method      VARCHAR(50)    DEFAULT 'manual',   -- manual | whatsapp | cash | transfer
  notes       TEXT,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_store ON payments(store_id);
CREATE INDEX IF NOT EXISTS idx_payments_date  ON payments(created_at DESC);

-- ══════════════════════════════════════════════
--   PLATFORM REVENUE VIEW (for super-admin stats cards)
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_platform_revenue AS
SELECT
  COALESCE(SUM(amount), 0)::NUMERIC(12,2)                             AS total_revenue,
  COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', NOW())
                    THEN amount END), 0)::NUMERIC(12,2)               AS monthly_revenue,
  COUNT(*)::INT                                                        AS total_payments,
  COALESCE(AVG(amount), 0)::NUMERIC(12,2)                             AS avg_payment
FROM payments;

-- ══════════════════════════════════════════════
--   OVERDUE ENFORCEMENT VIEW
--   Shows stores that need auto-expiry.
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_overdue_stores AS
SELECT
  id, name, email, status, payment_status, payment_due_date,
  EXTRACT(EPOCH FROM (NOW() - payment_due_date)) / 86400 AS days_overdue
FROM stores
WHERE is_admin         = FALSE
  AND payment_status   = 'unpaid'
  AND payment_due_date IS NOT NULL
  AND payment_due_date < NOW()
  AND status NOT IN ('lifetime', 'expired')
ORDER BY days_overdue DESC;
