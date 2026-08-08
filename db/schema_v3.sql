-- ══════════════════════════════════════════════
--   VaultixPOS — Schema v3 Migration
--   Run: psql $DATABASE_URL -f db/schema_v3.sql
-- ══════════════════════════════════════════════

-- ══════════════════════════════════════════════
--   EMPLOYEES TABLE
--   Each store (owner) can add cashier accounts.
--   Employee logs in with: store_id + employee_num + PIN.
-- ══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS employees (
  id            SERIAL PRIMARY KEY,
  store_id      INTEGER      NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  employee_num  VARCHAR(50)  NOT NULL,          -- Short ID the employee uses to login (e.g. "1", "EMP01")
  pin_hash      VARCHAR(255) NOT NULL,          -- bcrypt hash of their 4-6 digit PIN
  phone         VARCHAR(50),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (store_id, employee_num)               -- employee numbers unique within a store
);

CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id);

-- ══════════════════════════════════════════════
--   TRACK WHICH EMPLOYEE MADE EACH SALE
-- ══════════════════════════════════════════════
ALTER TABLE sales ADD COLUMN IF NOT EXISTS employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sales_employee ON sales(employee_id);

-- ══════════════════════════════════════════════
--   VIEW: EMPLOYEE SALES SUMMARY (per store, per day)
--   Owner uses this to see "who sold what"
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_employee_sales AS
SELECT
  e.store_id,
  e.id                             AS employee_id,
  e.name                           AS employee_name,
  e.employee_num,
  COUNT(s.id)                      AS total_transactions,
  COALESCE(SUM(s.quantity), 0)     AS total_units_sold,
  COALESCE(SUM(s.total_price), 0)  AS total_revenue,
  MAX(s.created_at)                AS last_sale_at
FROM employees e
LEFT JOIN sales s ON s.employee_id = e.id
WHERE e.is_active = TRUE
GROUP BY e.store_id, e.id, e.name, e.employee_num
ORDER BY total_revenue DESC;

-- ══════════════════════════════════════════════
--   VIEW: TODAY'S EMPLOYEE SALES
-- ══════════════════════════════════════════════
CREATE OR REPLACE VIEW v_employee_sales_today AS
SELECT
  e.store_id,
  e.id                             AS employee_id,
  e.name                           AS employee_name,
  e.employee_num,
  COUNT(s.id)                      AS transactions_today,
  COALESCE(SUM(s.quantity), 0)     AS units_today,
  COALESCE(SUM(s.total_price), 0)  AS revenue_today
FROM employees e
LEFT JOIN sales s ON s.employee_id = e.id AND s.created_at::date = CURRENT_DATE
WHERE e.is_active = TRUE
GROUP BY e.store_id, e.id, e.name, e.employee_num
ORDER BY revenue_today DESC;
