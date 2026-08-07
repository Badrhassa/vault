-- ══════════════════════════════════════════════
--   VaultixPOS — PostgreSQL Schema
--   Run: psql -d YOUR_DB -f db/schema.sql
-- ══════════════════════════════════════════════

-- ── Extensions ──
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ══════════════════════════════════════════════
--   STORES  (one row per tenant / store owner)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stores (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255)  NOT NULL,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  phone         VARCHAR(50),
  status        VARCHAR(20)   NOT NULL DEFAULT 'trial'
                  CHECK (status IN ('trial', 'active', 'expired')),
  trial_expiry  TIMESTAMPTZ,
  is_admin      BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stores_updated_at ON stores;
CREATE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ══════════════════════════════════════════════
--   PRODUCTS  (inventory per store)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS products (
  id         SERIAL PRIMARY KEY,
  store_id   INTEGER        NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       VARCHAR(255)   NOT NULL,
  price      NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
  stock      INTEGER        NOT NULL DEFAULT 0     CHECK (stock  >= 0),
  created_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ══════════════════════════════════════════════
--   SALES  (each recorded sale transaction)
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sales (
  id          SERIAL PRIMARY KEY,
  store_id    INTEGER        NOT NULL REFERENCES stores(id)   ON DELETE CASCADE,
  product_id  INTEGER        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    INTEGER        NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12, 2) NOT NULL,
  total_price NUMERIC(12, 2) NOT NULL,
  created_at  TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- ══════════════════════════════════════════════
--   INDEXES
-- ══════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_stores_email       ON stores(email);
CREATE INDEX IF NOT EXISTS idx_stores_status      ON stores(status);
CREATE INDEX IF NOT EXISTS idx_products_store     ON products(store_id);
CREATE INDEX IF NOT EXISTS idx_products_stock     ON products(store_id, stock);
CREATE INDEX IF NOT EXISTS idx_sales_store        ON sales(store_id);
CREATE INDEX IF NOT EXISTS idx_sales_product      ON sales(product_id);
CREATE INDEX IF NOT EXISTS idx_sales_date         ON sales(store_id, created_at);

-- ══════════════════════════════════════════════
--   HELPFUL VIEWS
-- ══════════════════════════════════════════════

-- Daily revenue per store
CREATE OR REPLACE VIEW v_daily_revenue AS
SELECT
  store_id,
  DATE(created_at)       AS sale_date,
  SUM(total_price)       AS revenue,
  COUNT(*)               AS transaction_count,
  SUM(quantity)          AS units_sold
FROM sales
GROUP BY store_id, DATE(created_at);

-- Low stock products (stock <= 5)
CREATE OR REPLACE VIEW v_low_stock AS
SELECT
  p.id,
  p.store_id,
  p.name,
  p.price,
  p.stock,
  s.name AS store_name
FROM products p
JOIN stores   s ON s.id = p.store_id
WHERE p.stock > 0 AND p.stock <= 5
ORDER BY p.stock ASC;

-- ══════════════════════════════════════════════
--   SEED — Super-Admin Account
--   Password: Admin@12345  (bcrypt, cost 12)
--   CHANGE THIS IN PRODUCTION!
-- ══════════════════════════════════════════════
INSERT INTO stores (name, email, password_hash, status, is_admin)
VALUES (
  'VaultixPOS Admin',
  'admin@vaultixpos.com',
  '$2b$10$xuy3hI8DHs4HR5NJqCeEyuy3i5ePy00uGue7YiqLfSHAPCRlPrn/y',
  'active',
  TRUE
)
ON CONFLICT (email) DO NOTHING;

-- ══════════════════════════════════════════════
--   QUICK SANITY CHECK
-- ══════════════════════════════════════════════
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public';
