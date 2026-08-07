'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');

const router  = express.Router();

function requireCashier(req, res, next) {
  if (req.session?.employeeId && req.session?.employeeStoreId) return next();
  if (req.headers['accept']?.includes('application/json'))
    return res.status(401).json({ success: false, message: 'يرجى تسجيل الدخول أولاً.' });
  return res.redirect('/cashier/login');
}

/* ── GET /cashier ── */
router.get('/', (req, res) => {
  return req.session?.employeeId ? res.redirect('/cashier/dashboard') : res.redirect('/cashier/login');
});

/* ── GET /cashier/login ── */
router.get('/login', (req, res) => {
  if (req.session?.employeeId) return res.redirect('/cashier/dashboard');
  res.render('cashier_login');
});

/* ── POST /cashier/login ── */
router.post('/login', async (req, res) => {
  const { storeId, employeeNum, pin } = req.body;
  if (!storeId || !employeeNum || !pin)
    return res.status(400).json({ success: false, message: 'جميع الحقول مطلوبة.' });

  try {
    const { rows } = await pool.query(
      `SELECT e.id, e.name, e.employee_num, e.pin_hash, e.store_id,
              s.name AS store_name, s.status AS store_status
       FROM employees e JOIN stores s ON s.id = e.store_id
       WHERE e.store_id = $1 AND e.employee_num = $2 AND e.is_active = TRUE LIMIT 1`,
      [parseInt(storeId, 10), employeeNum.trim()]
    );

    if (!rows.length)
      return res.status(401).json({ success: false, message: 'رقم الموظف أو رقم المتجر غير صحيح.' });

    const emp = rows[0];
    if (!['active', 'trial', 'lifetime'].includes(emp.store_status))
      return res.status(403).json({ success: false, message: 'اشتراك المتجر منتهي. تواصل مع المالك.' });

    const pinMatch = await bcrypt.compare(String(pin), emp.pin_hash);
    if (!pinMatch)
      return res.status(401).json({ success: false, message: 'البيزق (PIN) غير صحيح.' });

    req.session.employeeId      = emp.id;
    req.session.employeeStoreId = emp.store_id;
    req.session.employeeName    = emp.name;
    req.session.employeeNum     = emp.employee_num;
    req.session.storeName       = emp.store_name;
    req.session.isEmployee      = true;
    delete req.session.storeId;
    delete req.session.isAdmin;

    return res.json({ success: true, message: `أهلاً ${emp.name}!`, redirect: '/cashier/dashboard' });
  } catch (err) {
    console.error('[POST /cashier/login]', err.message);
    return res.status(500).json({ success: false, message: 'خطأ في السيرفر.' });
  }
});

/* ── GET /cashier/dashboard ── */
router.get('/dashboard', requireCashier, async (req, res) => {
  const { employeeId, employeeStoreId, employeeName, employeeNum } = req.session;
  try {
    const [productsRes, statsRes, salesRes, storeRes] = await Promise.all([
      pool.query(
        `SELECT id, name, price, stock, category, sku, image_url
         FROM products WHERE store_id = $1 ORDER BY category NULLS LAST, name ASC`,
        [employeeStoreId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(total_price),0)::NUMERIC(12,2) AS revenue,
                COUNT(*)                                    AS transactions,
                COALESCE(SUM(quantity),0)                  AS units_sold
         FROM sales WHERE employee_id=$1 AND created_at::date=CURRENT_DATE`,
        [employeeId]
      ),
      pool.query(
        `SELECT s.id, s.quantity, s.unit_price, s.total_price, s.created_at, p.name AS product_name
         FROM sales s JOIN products p ON p.id=s.product_id
         WHERE s.employee_id=$1 AND s.created_at::date=CURRENT_DATE
         ORDER BY s.created_at DESC LIMIT 30`,
        [employeeId]
      ),
      pool.query('SELECT name FROM stores WHERE id=$1 LIMIT 1', [employeeStoreId]),
    ]);

    res.render('cashier_dashboard', {
      employee:    { id: employeeId, name: employeeName, num: employeeNum, storeId: employeeStoreId },
      store:       storeRes.rows[0] || { name: 'المتجر' },
      products:    productsRes.rows,
      stats:       statsRes.rows[0],
      recentSales: salesRes.rows,
    });
  } catch (err) {
    console.error('[GET /cashier/dashboard]', err.message);
    res.status(500).send('<h2>خطأ في تحميل لوحة الكاشير</h2>');
  }
});

/* ════════════════════════════════════════
   Shared checkout logic (BATCH CART)
   Processes the full cart in ONE transaction.
   Returns { status, body } instead of touching
   req/res directly so it can be reused safely
   by both /checkout and the legacy /sales route
   (previously done via a fragile router.handle()
   call that spread a fake req object — replaced
   with a plain function call instead).
════════════════════════════════════════ */
async function processCheckout(items, employeeId, employeeStoreId) {
  if (!Array.isArray(items) || items.length === 0)
    return { status: 400, body: { success: false, message: 'السلة فارغة.' } };

  /* Validate each item before hitting the DB */
  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (!item.productId || isNaN(qty) || qty < 1)
      return { status: 400, body: { success: false, message: 'بيانات السلة غير صحيحة.' } };
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const results   = [];
    let   cartTotal = 0;

    for (const item of items) {
      const qty = parseInt(item.quantity, 10);

      /* Lock row */
      const prod = await client.query(
        `SELECT id, name, price, stock FROM products
         WHERE id=$1 AND store_id=$2 FOR UPDATE`,
        [item.productId, employeeStoreId]
      );

      if (!prod.rows.length) {
        await client.query('ROLLBACK');
        return { status: 404, body: { success: false, message: `منتج #${item.productId} غير موجود.` } };
      }

      const p = prod.rows[0];
      if (p.stock < qty) {
        await client.query('ROLLBACK');
        return {
          status: 409,
          body: { success: false, message: `"${p.name}" — متاح ${p.stock} فقط (طلبت ${qty}).` },
        };
      }

      const unitPrice  = parseFloat(p.price);
      const lineTotal  = parseFloat((unitPrice * qty).toFixed(2));
      const newStock   = p.stock - qty;

      await client.query('UPDATE products SET stock=$1 WHERE id=$2', [newStock, p.id]);

      const { rows: saleRows } = await client.query(
        `INSERT INTO sales (store_id, product_id, quantity, unit_price, total_price, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
        [employeeStoreId, p.id, qty, unitPrice, lineTotal, employeeId]
      );

      cartTotal += lineTotal;
      results.push({
        saleId:      saleRows[0].id,
        productId:   p.id,
        productName: p.name,
        quantity:    qty,
        unitPrice,
        lineTotal,
        newStock,
      });
    }

    await client.query('COMMIT');

    return {
      status: 201,
      body: {
        success:    true,
        results,
        cartTotal:  parseFloat(cartTotal.toFixed(2)),
        itemCount:  items.length,
        message:    `تم بيع ${items.length} صنف بإجمالي ج ${cartTotal.toFixed(2)}`,
      },
    };

  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[processCheckout]', err.message);
    return { status: 500, body: { success: false, message: 'خطأ في إتمام البيع. حاول مرة أخرى.' } };
  } finally {
    if (client) client.release();
  }
}

/* ════════════════════════════════════════
   POST /cashier/checkout  (BATCH CART)
   Body: { items: [{ productId, quantity }] }
════════════════════════════════════════ */
router.post('/checkout', requireCashier, async (req, res) => {
  const { employeeId, employeeStoreId } = req.session;
  const result = await processCheckout(req.body.items, employeeId, employeeStoreId);
  res.status(result.status).json(result.body);
});

/* ── POST /cashier/sales (single item — kept for backwards compat) ── */
router.post('/sales', requireCashier, async (req, res) => {
  const { employeeId, employeeStoreId } = req.session;
  const items = [{ productId: req.body.productId, quantity: req.body.quantity }];
  const result = await processCheckout(items, employeeId, employeeStoreId);
  res.status(result.status).json(result.body);
});

/* ── GET /cashier/logout ── */
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('[GET /cashier/logout]', err.message);
    res.redirect('/cashier/login');
  });
});

module.exports = router;