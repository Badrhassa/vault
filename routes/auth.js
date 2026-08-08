'use strict';

/**
 * routes/auth.js  — Authentication + Dashboard render
 * v2: register → status 'pending', dashboard includes full stats,
 *     recent sales, notifications, whatsappNumber.
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const pool    = require('../db/pool');
const { requireAuth }           = require('../middleware/auth');
const checkSubscription         = require('../middleware/checkSubscription');

const router = express.Router();

/* ════════════════════════════════════════
   GET /login
════════════════════════════════════════ */
router.get('/login', (req, res) => {
  if (req.session.storeId) return res.redirect('/dashboard');
  res.render('login');
});

/* ════════════════════════════════════════
   POST /login
   Body: { email, password }
════════════════════════════════════════ */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    return res.status(400).send('Email and password are required.');
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, password_hash, status, is_admin FROM stores WHERE email=$1 LIMIT 1',
      [email.trim().toLowerCase()]
    );

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      if (req.xhr || req.headers.accept?.includes('json')) {
        return res.status(401).json({ success: false, message: 'Invalid email or password.' });
      }
      return res.status(401).send('Invalid email or password.');
    }

    const store = rows[0];

    // حفظ بيانات الجلسة
    req.session.storeId     = store.id;
    req.session.storeName   = store.name;
    req.session.storeStatus = store.status;
    req.session.isAdmin     = store.is_admin;
    req.session.adminName   = store.is_admin ? store.name : undefined;

    /* Update last_seen */
    pool.query('UPDATE stores SET last_seen=NOW() WHERE id=$1', [store.id]).catch(() => {});

    const targetUrl = store.is_admin
      ? '/admin'
      : store.status === 'pending'
        ? '/pending'
        : store.status === 'expired'
          ? '/expired'
          : '/dashboard';

    // حفظ الجلسة بوضوح قبل إعادة التوجيه
    return req.session.save((err) => {
      if (err) {
        console.error('[SESSION SAVE ERROR]', err);
        return res.status(500).send('Session save error');
      }

      // دعم الاتجاهين: لو الطلب Fetch بيبعت JSON، ولو Form عادية بيعمل Redirect
      if (req.xhr || req.headers.accept?.includes('json')) {
        return res.json({ success: true, message: 'Login successful!', redirect: targetUrl, redirectTo: targetUrl });
      } else {
        return res.redirect(targetUrl);
      }
    });

  } catch (err) {
    console.error('[POST /login]', err.message);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});


/* ════════════════════════════════════════
   GET /register
════════════════════════════════════════ */
router.get('/register', (req, res) => {
  if (req.session.storeId) return res.redirect('/dashboard');
  res.render('register');
});

/* ════════════════════════════════════════
   POST /register
   Body: { storeName, email, password, phone }
   ⚠️  v2: status is set to 'pending' — no auto trial.
   Redirects to /pending after registration.
════════════════════════════════════════ */
router.post('/register', async (req, res) => {
  const { storeName, email, password, phone } = req.body;

  if (!storeName?.trim() || !email?.trim() || !password)
    return res.status(400).json({ success: false, message: 'Store name, email, and password are required.' });
  if (password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });

  try {
    const dupe = await pool.query('SELECT id FROM stores WHERE email=$1 LIMIT 1', [email.trim().toLowerCase()]);
    if (dupe.rows.length)
      return res.status(409).json({ success: false, message: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);

    const { rows } = await pool.query(
      `INSERT INTO stores (name, email, password_hash, phone, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, name, status`,
      [storeName.trim(), email.trim().toLowerCase(), hash, phone?.trim() || null]
    );

    const store = rows[0];
    req.session.storeId     = store.id;
    req.session.storeName   = store.name;
    req.session.storeStatus = 'pending';
    req.session.isAdmin     = false;

    /* ← Key change: redirect to /pending, NOT /dashboard */
    return res.status(201).json({
      success:  true,
      message:  'Account created! Please contact the developer to activate your trial.',
      redirect: '/pending',
    });

  } catch (err) {
    console.error('[POST /register]', err.message);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

/* ════════════════════════════════════════
   GET /pending
   Shown to users whose account status is 'pending'.
   Exempt from checkSubscription (handled in middleware).
════════════════════════════════════════ */
router.get('/pending', requireAuth, async (req, res) => {
  try {
    const waResult = await pool.query(
      "SELECT value FROM admin_config WHERE key='whatsapp_number' LIMIT 1"
    );
    res.render('pending', {
      storeName:       req.session.storeName || '',
      whatsappNumber:  waResult.rows[0]?.value || '',
    });
  } catch (err) {
    res.render('pending', { storeName: req.session.storeName || '', whatsappNumber: '' });
  }
});

/* ════════════════════════════════════════
   GET /expired
   Shown when subscription has expired.
   Exempt from checkSubscription.
════════════════════════════════════════ */
router.get('/expired', requireAuth, async (req, res) => {
  try {
    const waResult = await pool.query(
      "SELECT value FROM admin_config WHERE key='whatsapp_number' LIMIT 1"
    );
    res.render('expired', {
      storeName:      req.session.storeName || '',
      whatsappNumber: waResult.rows[0]?.value || '',
    });
  } catch (err) {
    res.render('expired', { storeName: req.session.storeName || '', whatsappNumber: '' });
  }
});

/* ════════════════════════════════════════
   GET /dashboard
   Full render with all data the EJS needs.
════════════════════════════════════════ */
router.get('/dashboard', requireAuth, checkSubscription, async (req, res) => {
  const storeId = req.session.storeId;

  try {
    const [productsRes, statsRes, salesRes, storeRes, notifRes, waRes] = await Promise.all([

      /* Products (with new category + sku fields) */
      pool.query(
        `SELECT id, name, price, stock, category, sku, created_at
         FROM products WHERE store_id=$1 ORDER BY created_at DESC`,
        [storeId]
      ),

      /* Aggregate stats: today + month + low stock + total */
      pool.query(
        `SELECT
           COALESCE((SELECT SUM(total_price) FROM sales WHERE store_id=$1
                     AND created_at::date=CURRENT_DATE),0)::NUMERIC(12,2)       AS "todaySales",
           COALESCE((SELECT SUM(total_price) FROM sales WHERE store_id=$1
                     AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW())),0)::NUMERIC(12,2) AS "monthlyRevenue",
           COUNT(CASE WHEN p.stock>0 AND p.stock<=5 THEN 1 END)                 AS "lowStockCount",
           COUNT(p.id)                                                            AS "totalProducts"
         FROM products p WHERE p.store_id=$1`,
        [storeId]
      ),

      /* Recent sales (last 100, for sales history tab) */
      pool.query(
        `SELECT s.id, s.quantity, s.unit_price, s.total_price, s.created_at,
                p.name AS product_name
         FROM sales s
         JOIN products p ON p.id=s.product_id
         WHERE s.store_id=$1
         ORDER BY s.created_at DESC LIMIT 100`,
        [storeId]
      ),

      /* Store info (subscription dates etc.) */
      pool.query(
        `SELECT id, name, status, subscription_end_date
         FROM stores WHERE id=$1 LIMIT 1`,
        [storeId]
      ),

      /* Unread admin notifications */
      pool.query(
        `SELECT id, message, created_at
         FROM notifications
         WHERE store_id=$1 AND is_read=FALSE
         ORDER BY created_at DESC`,
        [storeId]
      ),

      /* WhatsApp number from admin_config */
      pool.query("SELECT value FROM admin_config WHERE key='whatsapp_number' LIMIT 1"),
    ]);

    res.render('dashboard', {
      store:           storeRes.rows[0] || { id: storeId, name: req.session.storeName, status: req.session.storeStatus },
      products:        productsRes.rows,
      stats:           statsRes.rows[0],
      recentSales:     salesRes.rows,
      notifications:   notifRes.rows,
      whatsappNumber:  waRes.rows[0]?.value || '',
    });

  } catch (err) {
    console.error('[GET /dashboard]', err.message);
    res.status(500).send('<h2>Error loading dashboard</h2><p>' + err.message + '</p>');
  }
});

/* ════════════════════════════════════════
   GET /logout
════════════════════════════════════════ */
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) console.error('[GET /logout] Session destroy error:', err.message);
    res.redirect('/login');
  });
});

module.exports = router;
