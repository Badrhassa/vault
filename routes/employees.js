'use strict';

/**
 * routes/employees.js
 * Store owner manages their cashier / employee accounts.
 * All routes require the owner to be authenticated.
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');
const { requireAuth }  = require('../middleware/auth');
const checkSubscription = require('../middleware/checkSubscription');
/* Employee limit per subscription plan */
const PLAN_EMPLOYEE_LIMITS = {
  basic:      1,
  premium:    3,
  enterprise: Infinity,
};

const router = express.Router();
router.use(requireAuth, checkSubscription);

/* ════════════════════════════════════════
   GET /api/employees
   Returns all employees for this store
   with their today's sales summary.
════════════════════════════════════════ */
router.get('/', async (req, res) => {
  const storeId = req.session.storeId;
  try {
    const { rows } = await pool.query(
      `SELECT
         e.id, e.name, e.employee_num, e.phone, e.is_active, e.created_at,
         COUNT(s.id)                                                          AS total_sales,
         COALESCE(SUM(CASE WHEN s.created_at::date = CURRENT_DATE
                           THEN s.total_price END), 0)::NUMERIC(12,2)        AS today_revenue,
         COUNT(CASE WHEN s.created_at::date = CURRENT_DATE THEN 1 END)       AS today_transactions
       FROM employees e
       LEFT JOIN sales s ON s.employee_id = e.id
       WHERE e.store_id = $1
       GROUP BY e.id, e.name, e.employee_num, e.phone, e.is_active, e.created_at
       ORDER BY e.created_at ASC`,
      [storeId]
    );
    res.json({ success: true, employees: rows });
  } catch (err) {
    console.error('[GET /api/employees]', err.message);
    res.status(500).json({ success: false, message: 'فشل تحميل بيانات الموظفين.' });
  }
});

/* ════════════════════════════════════════
   POST /api/employees
   Body: { name, employeeNum, pin, phone? }
   PIN is bcrypt-hashed before storage.
════════════════════════════════════════ */
router.post('/', async (req, res) => {
  const { name, employeeNum, pin, phone } = req.body;
  const storeId = req.session.storeId;

  if (!name?.trim())        return res.status(400).json({ success: false, message: 'اسم الموظف مطلوب.' });
  if (!employeeNum?.trim()) return res.status(400).json({ success: false, message: 'رقم الموظف مطلوب.' });
  if (!pin || String(pin).length < 4)
    return res.status(400).json({ success: false, message: 'البيزق يجب أن يكون 4 أرقام على الأقل.' });
  if (String(pin).length > 6)
    return res.status(400).json({ success: false, message: 'البيزق يجب ألا يتجاوز 6 أرقام.' });
  if (!/^\d+$/.test(String(pin)))
    return res.status(400).json({ success: false, message: 'البيزق أرقام فقط (4–6 أرقام).' });

  try {
    /* ── Enforce employee limit based on subscription plan ── */
    const storeRes = await pool.query(
      'SELECT subscription_plan FROM stores WHERE id = $1 LIMIT 1',
      [storeId]
    );
    const plan  = storeRes.rows[0]?.subscription_plan || 'basic';
    const limit = PLAN_EMPLOYEE_LIMITS[plan] ?? PLAN_EMPLOYEE_LIMITS.basic;

    if (limit !== Infinity) {
      const countRes = await pool.query(
        'SELECT COUNT(*)::int AS count FROM employees WHERE store_id = $1',
        [storeId]
      );
      if (countRes.rows[0].count >= limit) {
        return res.status(403).json({
          success: false,
          message: `وصلت للحد الأقصى لعدد الموظفين في خطتك (${limit}). رقّي خطتك عشان تضيف أكتر.`,
        });
      }
    }

    /* Check duplicate employee_num within this store */
    const dupe = await pool.query(
      'SELECT id FROM employees WHERE store_id = $1 AND employee_num = $2 LIMIT 1',
      [storeId, employeeNum.trim()]
    );
    if (dupe.rows.length)
      return res.status(409).json({ success: false, message: 'رقم الموظف ده موجود بالفعل في متجرك.' });

    /* Hash PIN */
    const pinHash = await bcrypt.hash(String(pin), 10);

    const { rows } = await pool.query(
      `INSERT INTO employees (store_id, name, employee_num, pin_hash, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, employee_num, phone, is_active, created_at`,
      [storeId, name.trim(), employeeNum.trim(), pinHash, phone?.trim() || null]
    );

    console.log(`[EMPLOYEES] New employee "${rows[0].name}" (#${rows[0].employee_num}) added to store ${storeId}`);
    res.status(201).json({ success: true, employee: rows[0] });

  } catch (err) {
    console.error('[POST /api/employees]', err.message);
    res.status(500).json({ success: false, message: 'خطأ في السيرفر. حاول مرة أخرى.' });
  }
});

/* ════════════════════════════════════════
   PATCH /api/employees/:id/pin
   Body: { pin }  — reset an employee's PIN.
════════════════════════════════════════ */
router.patch('/:id/pin', async (req, res) => {
  const { pin } = req.body;
  const storeId = req.session.storeId;

  if (!pin || String(pin).length < 4 || String(pin).length > 6 || !/^\d+$/.test(String(pin)))
    return res.status(400).json({ success: false, message: 'البيزق يجب أن يكون 4–6 أرقام.' });

  try {
    const pinHash = await bcrypt.hash(String(pin), 10);
    const { rows } = await pool.query(
      `UPDATE employees SET pin_hash = $1
       WHERE id = $2 AND store_id = $3
       RETURNING id, name, employee_num`,
      [pinHash, req.params.id, storeId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'الموظف غير موجود.' });
    res.json({ success: true, employee: rows[0], message: 'تم تحديث البيزق بنجاح.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تحديث البيزق.' });
  }
});

/* ════════════════════════════════════════
   PATCH /api/employees/:id/toggle
   Toggle is_active status.
════════════════════════════════════════ */
router.patch('/:id/toggle', async (req, res) => {
  const storeId = req.session.storeId;
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET is_active = NOT is_active
       WHERE id = $1 AND store_id = $2
       RETURNING id, name, employee_num, is_active`,
      [req.params.id, storeId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'الموظف غير موجود.' });
    res.json({ success: true, employee: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'خطأ في تغيير حالة الموظف.' });
  }
});

/* ════════════════════════════════════════
   DELETE /api/employees/:id
   Permanently removes an employee.
   Their past sales remain (employee_id set to NULL).
════════════════════════════════════════ */
router.delete('/:id', async (req, res) => {
  const storeId = req.session.storeId;
  try {
    const { rows } = await pool.query(
      'DELETE FROM employees WHERE id = $1 AND store_id = $2 RETURNING id, name',
      [req.params.id, storeId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'الموظف غير موجود.' });
    res.json({ success: true, message: `تم حذف "${rows[0].name}" بنجاح.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'فشل حذف الموظف.' });
  }
});

/* ════════════════════════════════════════
   GET /api/employees/sales
   Returns today's sales grouped by employee.
   Owner uses this to see "who sold what".
════════════════════════════════════════ */
router.get('/sales', async (req, res) => {
  const storeId = req.session.storeId;
  const date    = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const { rows } = await pool.query(
      `SELECT
         e.id AS employee_id, e.name, e.employee_num,
         COUNT(s.id)::INT                          AS transactions,
         COALESCE(SUM(s.quantity), 0)::INT         AS units_sold,
         COALESCE(SUM(s.total_price),0)::NUMERIC(12,2) AS revenue
       FROM employees e
       LEFT JOIN sales s
         ON s.employee_id = e.id
        AND s.store_id    = $1
        AND s.created_at::date = $2::date
       WHERE e.store_id = $1
       GROUP BY e.id, e.name, e.employee_num
       ORDER BY revenue DESC`,
      [storeId, date]
    );
    res.json({ success: true, date, salesByEmployee: rows });
  } catch (err) {
    console.error('[GET /api/employees/sales]', err.message);
    res.status(500).json({ success: false, message: 'فشل تحميل تقارير الموظفين.' });
  }
});

module.exports = router;
