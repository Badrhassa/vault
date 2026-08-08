'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');
const { requireAdmin }          = require('../middleware/auth');
const { runOverdueEnforcement } = require('../middleware/checkSubscription');

const router = express.Router();
router.use(requireAdmin);

/* ════════════════════════════════════════
   GET /admin
   Renders the super-admin control panel with
   financial stats, payment status, and store list.
════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    const [storesRes, waRes, revenueRes, pendingRes, overdueRes] = await Promise.all([

      pool.query(
        `SELECT s.id, s.name, s.email, s.phone, s.status,
                s.subscription_end_date, s.last_seen, s.created_at,
                s.payment_status, s.payment_due_date, s.subscription_plan,
                COALESCE(p.last_paid, NULL) AS last_paid,
                COALESCE(p.total_paid, 0)  AS total_paid
         FROM stores s
         LEFT JOIN (
           SELECT store_id,
                  MAX(created_at)  AS last_paid,
                  SUM(amount)      AS total_paid
           FROM payments GROUP BY store_id
         ) p ON p.store_id = s.id
         WHERE s.is_admin = FALSE
         ORDER BY s.created_at DESC`
      ),

      pool.query("SELECT value FROM admin_config WHERE key = 'whatsapp_number' LIMIT 1"),

      /* Platform revenue stats */
      pool.query(`
        SELECT
          COALESCE(SUM(amount), 0)::NUMERIC(12,2) AS total_revenue,
          COALESCE(SUM(CASE WHEN created_at >= DATE_TRUNC('month', NOW()) THEN amount END), 0)::NUMERIC(12,2) AS monthly_revenue,
          COUNT(*)::INT AS total_payments
        FROM payments
      `),

      /* Stores with unpaid + due date in the future (genuinely pending) */
      pool.query(`
        SELECT COUNT(*)::INT AS cnt FROM stores
        WHERE is_admin = FALSE AND payment_status = 'unpaid'
          AND (payment_due_date IS NULL OR payment_due_date >= NOW())
      `),

      /* Stores overdue (payment_due_date passed, not yet expired) */
      pool.query(`
        SELECT COUNT(*)::INT AS cnt FROM stores
        WHERE is_admin = FALSE
          AND payment_status IN ('unpaid','overdue')
          AND payment_due_date IS NOT NULL
          AND payment_due_date < NOW()
          AND status NOT IN ('expired','lifetime')
      `),
    ]);

    const rev = revenueRes.rows[0];

    res.render('admin', {
      stores:          storesRes.rows,
      adminName:       req.session.adminName || req.session.storeName || 'Administrator',
      whatsappNumber:  waRes.rows[0]?.value || '',
      platformStats:   {},
      finStats: {
        totalRevenue:   parseFloat(rev.total_revenue   || 0).toFixed(2),
        monthlyRevenue: parseFloat(rev.monthly_revenue || 0).toFixed(2),
        totalPayments:  rev.total_payments || 0,
        pendingCount:   pendingRes.rows[0]?.cnt  || 0,
        overdueCount:   overdueRes.rows[0]?.cnt  || 0,
      },
    });

  } catch (err) {
    console.error('[GET /admin]', err.message);
    res.status(500).send('<h2>Error loading admin panel</h2><p>' + err.message + '</p>');
  }
});

/* ════════════════════════════════════════
   POST /admin/billing/enforce
   Manually trigger overdue enforcement (no cron needed).
   Also called automatically from the background setInterval.
════════════════════════════════════════ */
router.post('/billing/enforce', async (req, res) => {
  try {
    await runOverdueEnforcement();
    res.json({ success: true, message: 'Overdue enforcement completed.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ════════════════════════════════════════
   POST /admin/stores/:id/record-payment
   Body: { amount, planName?, method?, notes?, daysToAdd? }
   Records a payment and extends the subscription.
════════════════════════════════════════ */
router.post('/stores/:id/record-payment', async (req, res) => {
  const { amount, planName, method, notes, daysToAdd } = req.body;
  const storeId = req.params.id;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
    return res.status(400).json({ success: false, message: 'Valid payment amount is required.' });

  const days = parseInt(daysToAdd, 10) || 30;

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    /* Insert payment record */
    await client.query(
      `INSERT INTO payments (store_id, amount, plan_name, method, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [storeId, parseFloat(amount), planName || null, method || 'manual', notes || null]
    );

    /* Calculate new subscription end date */
    const sedResult = await client.query(
      'SELECT subscription_end_date, status FROM stores WHERE id = $1 FOR UPDATE',
      [storeId]
    );
    if (!sedResult.rows.length) throw new Error('Store not found.');

    const current = sedResult.rows[0].subscription_end_date;
    const base    = (current && new Date(current) > new Date()) ? new Date(current) : new Date();
    const newEnd  = new Date(base.getTime() + days * 86400000);

    /* Update store: mark paid, extend subscription, set active if was expired/pending */
    const currentStatus = sedResult.rows[0].status;
    const newStatus     = ['expired', 'pending', 'overdue'].includes(currentStatus) ? 'active' : currentStatus;

    const { rows } = await client.query(
      `UPDATE stores
       SET payment_status       = 'paid',
           payment_due_date     = $1,
           subscription_end_date = $2,
           status               = $3
       WHERE id = $4
       RETURNING id, name, status, payment_status, subscription_end_date`,
      [newEnd, newEnd, newStatus, storeId]
    );

    await client.query('COMMIT');

    console.log(`[BILLING] Payment recorded for "${rows[0].name}" — amount: ${amount}, days: +${days}`);
    res.json({ success: true, store: rows[0], message: `Payment recorded. Subscription extended by ${days} days.` });

  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /admin/stores/:id/record-payment]', err.message);
    res.status(500).json({ success: false, message: 'Failed to record payment.' });
  } finally {
    if (client) client.release();
  }
});

/* ════════════════════════════════════════
   GET /admin/billing/history/:id
   Returns payment history for one store.
════════════════════════════════════════ */
router.get('/billing/history/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, amount, plan_name, method, notes, created_at
       FROM payments WHERE store_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ success: true, payments: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch payment history.' });
  }
});

/* ════════════════════════════════════════
   POST /admin/stores/:id/toggle-status
════════════════════════════════════════ */
router.post('/stores/:id/toggle-status', async (req, res) => {
  const { status } = req.body;
  const VALID = ['active', 'trial', 'expired', 'pending', 'lifetime'];
  if (!VALID.includes(status))
    return res.status(400).json({ success: false, message: `Invalid status. Must be: ${VALID.join(', ')}.` });

  try {
    const { rows } = await pool.query(
      `UPDATE stores SET status = $1 WHERE id = $2 AND is_admin = FALSE
       RETURNING id, name, email, status, subscription_end_date`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Store not found.' });
    res.json({ success: true, store: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update status.' });
  }
});

/* ════════════════════════════════════════
   POST /admin/stores/:id/extend-days
════════════════════════════════════════ */
router.post('/stores/:id/extend-days', async (req, res) => {
  const days = parseInt(req.body.days, 10);
  if (isNaN(days) || days < 1 || days > 3650)
    return res.status(400).json({ success: false, message: 'Days must be 1–3650.' });

  try {
    const cur = await pool.query(
      'SELECT subscription_end_date, status FROM stores WHERE id=$1 AND is_admin=FALSE LIMIT 1',
      [req.params.id]
    );
    if (!cur.rows.length) return res.status(404).json({ success: false, message: 'Store not found.' });

    const existing = cur.rows[0].subscription_end_date;
    const base     = (existing && new Date(existing) > new Date()) ? new Date(existing) : new Date();
    const newEnd   = new Date(base.getTime() + days * 86400000);
    const curSt    = cur.rows[0].status;
    const newSt    = ['expired', 'pending'].includes(curSt) ? 'trial' : curSt;

    const { rows } = await pool.query(
      `UPDATE stores SET subscription_end_date=$1, status=$2
       WHERE id=$3 AND is_admin=FALSE
       RETURNING id, name, status, subscription_end_date`,
      [newEnd, newSt, req.params.id]
    );
    res.json({ success: true, store: rows[0], subscription_end_date: newEnd });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to extend subscription.' });
  }
});

/* ════════════════════════════════════════
   POST /admin/stores/:id/notify
════════════════════════════════════════ */
router.post('/stores/:id/notify', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim() || message.trim().length > 500)
    return res.status(400).json({ success: false, message: 'Message is required (max 500 chars).' });

  try {
    const check = await pool.query(
      'SELECT id, name FROM stores WHERE id=$1 AND is_admin=FALSE LIMIT 1', [req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ success: false, message: 'Store not found.' });
    const { rows } = await pool.query(
      'INSERT INTO notifications (store_id, message) VALUES ($1, $2) RETURNING id',
      [req.params.id, message.trim()]
    );
    res.status(201).json({ success: true, notification: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send notification.' });
  }
});

/* ════════════════════════════════════════
   POST /admin/stores/create
════════════════════════════════════════ */
router.post('/stores/create', async (req, res) => {
  const { storeName, email, password, phone, status, subscriptionDays } = req.body;
  if (!storeName?.trim() || !email?.trim() || !password)
    return res.status(400).json({ success: false, message: 'Name, email, and password are required.' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

  const VALID_STATUSES = ['pending', 'trial', 'active', 'lifetime'];
  const chosenStatus   = VALID_STATUSES.includes(status) ? status : 'pending';
  let subEndDate = null;
  if (['trial', 'active'].includes(chosenStatus)) {
    const days = parseInt(subscriptionDays, 10);
    if (!isNaN(days) && days > 0)
      subEndDate = new Date(Date.now() + days * 86400000);
  }

  try {
    const dupe = await pool.query('SELECT id FROM stores WHERE email=$1 LIMIT 1', [email.trim().toLowerCase()]);
    if (dupe.rows.length)
      return res.status(409).json({ success: false, message: 'Email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO stores (name, email, password_hash, phone, status, subscription_end_date)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, email, phone, status, subscription_end_date, created_at`,
      [storeName.trim(), email.trim().toLowerCase(), hash, phone?.trim() || null, chosenStatus, subEndDate]
    );
    res.status(201).json({ success: true, store: rows[0] });
  } catch (err) {
    console.error('[POST /admin/stores/create]', err.message);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/* ════════════════════════════════════════
   DELETE /admin/stores/:id
════════════════════════════════════════ */
router.delete('/stores/:id', async (req, res) => {
  if (req.headers['x-confirm-delete'] !== 'true')
    return res.status(400).json({ success: false, message: 'Requires X-Confirm-Delete: true header.' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM stores WHERE id=$1 AND is_admin=FALSE RETURNING id, name', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Store not found.' });
    res.json({ success: true, message: `"${rows[0].name}" permanently deleted.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete store.' });
  }
});

/* ════════════════════════════════════════
   GET /admin/stores/:id/stats
════════════════════════════════════════ */
router.get('/stores/:id/stats', async (req, res) => {
  const { id } = req.params;
  try {
    const [storeRes, prodRes, salesRes, payRes] = await Promise.all([
      pool.query('SELECT id,name,email,status,payment_status FROM stores WHERE id=$1 AND is_admin=FALSE LIMIT 1',[id]),
      pool.query(`SELECT COUNT(*) AS total,SUM(CASE WHEN stock=0 THEN 1 ELSE 0 END) AS out,SUM(CASE WHEN stock>0 AND stock<=5 THEN 1 ELSE 0 END) AS low FROM products WHERE store_id=$1`,[id]),
      pool.query(`SELECT COUNT(*) AS total_sales,COALESCE(SUM(total_price),0) AS all_time,COALESCE(SUM(CASE WHEN created_at::date=CURRENT_DATE THEN total_price END),0) AS today FROM sales WHERE store_id=$1`,[id]),
      pool.query('SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments WHERE store_id=$1',[id]),
    ]);
    if (!storeRes.rows.length) return res.status(404).json({ success: false, message: 'Store not found.' });
    res.json({ success: true, store: storeRes.rows[0], products: prodRes.rows[0], sales: salesRes.rows[0], payments: payRes.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

/* ════════════════════════════════════════
   POST /admin/config/whatsapp
════════════════════════════════════════ */
router.post('/config/whatsapp', async (req, res) => {
  const number = (req.body.number || '').replace(/\D/g, '');
  if (!number || number.length < 7)
    return res.status(400).json({ success: false, message: 'Invalid phone number.' });
  try {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ('whatsapp_number',$1,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [number]
    );
    res.json({ success: true, number });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update WhatsApp number.' });
  }
});

module.exports = router;
