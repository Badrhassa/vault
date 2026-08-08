-- ══════════════════════════════════════════════
--   VaultixPOS — Schema v2 Migration
--   Run: psql $DATABASE_URL -f db/schema_v2.sql
-- ══════════════════════════════════════════════

-- ── Extend stores.status to include 'pending' and 'lifetime' ──
ALTER TABLE stores DROP CONSTRAINT IF EXISTS stores_status_check;
ALTER TABLE stores
  ADD CONSTRAINT stores_status_check
  CHECK (status IN ('pending', 'trial', 'active', 'expired', 'lifetime'));

-- Change default for new registrations to 'pending' (no free trial)
ALTER TABLE stores ALTER COLUMN status SET DEFAULT 'pending';

-- ── Add last_seen for online-activity tracking ──
ALTER TABLE stores ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;

-- ── Rename trial_expiry → subscription_end_date (covers both trial & paid) ──
-- Safe rename: add new column, copy data, keep old column as alias
ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_end_date TIMESTAMPTZ;
UPDATE stores SET subscription_end_date = trial_expiry WHERE subscription_end_date IS NULL AND trial_expiry IS NOT NULL;
-- (trial_expiry column kept for backwards compatibility; drop when ready)

-- ── Products: add category and SKU ──
ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku      VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(store_id, category);

-- ══════════════════════════════════════════════
--   NOTIFICATIONS TABLE
--   Stores in-app messages sent by super-admin
--   to individual store dashboards.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  store_id   INTEGER      NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  message    TEXT         NOT NULL,
  is_read    BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_store   ON notifications(store_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at DESC);

-- ══════════════════════════════════════════════
--   ADMIN CONFIG TABLE
--   Key-value store for platform-level settings
--   (e.g. WhatsApp number, support email).
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_config (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT         NOT NULL,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed default WhatsApp number (update via admin UI)
INSERT INTO admin_config (key, value) VALUES
  ('whatsapp_number', '1234567890'),
  ('support_message', 'Hello, I need help with my VaultixPOS account.')
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════
--   UPDATED DAILY REVENUE VIEW
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_daily_revenue AS
SELECT
  store_id,
  DATE(created_at)  AS sale_date,
  SUM(total_price)  AS revenue,
  COUNT(*)          AS transaction_count,
  SUM(quantity)     AS units_sold
FROM sales
GROUP BY store_id, DATE(created_at);

-- ══════════════════════════════════════════════
--   UPDATED LOW STOCK VIEW
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_low_stock AS
SELECT p.id, p.store_id, p.name, p.price, p.stock, p.category, p.sku, s.name AS store_name
FROM   products p
JOIN   stores   s ON s.id = p.store_id
WHERE  p.stock > 0 AND p.stock <= 5
ORDER BY p.stock ASC;

-- ══════════════════════════════════════════════
--   PLATFORM STATS VIEW (for super-admin)
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_platform_stats AS
SELECT
  COUNT(*)                                          AS total_stores,
  COUNT(CASE WHEN status = 'active'   THEN 1 END)  AS active_stores,
  COUNT(CASE WHEN status = 'trial'    THEN 1 END)  AS trial_stores,
  COUNT(CASE WHEN status = 'pending'  THEN 1 END)  AS pending_stores,
  COUNT(CASE WHEN status = 'expired'  THEN 1 END)  AS expired_stores,
  COUNT(CASE WHEN status = 'lifetime' THEN 1 END)  AS lifetime_stores,
  COUNT(CASE WHEN last_seen >= NOW() - INTERVAL '15 minutes' THEN 1 END) AS online_now
FROM stores
WHERE is_admin = FALSE;
