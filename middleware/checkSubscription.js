'use strict';

const pool = require('../db/pool');

/**
 * Routes always reachable — never blocked regardless of status.
 */
const ALWAYS_ALLOW = [
  '/login', '/register', '/logout',
  '/support', '/pending', '/expired',
  '/api/check-status',
  '/favicon.ico',
];

/* ════════════════════════════════════════
   BACKGROUND OVERDUE ENFORCEMENT
   Called once at server startup via setInterval (in app.js).
   Also called from the middleware below for immediate enforcement.
   NO node-cron needed.
════════════════════════════════════════ */
async function runOverdueEnforcement() {
  try {
    /* Auto-expire stores unpaid for > 3 days */
    const expired = await pool.query(`
      UPDATE stores
      SET    status         = 'expired',
             payment_status = 'overdue'
      WHERE  is_admin        = FALSE
        AND  payment_status  = 'unpaid'
        AND  payment_due_date IS NOT NULL
        AND  payment_due_date < NOW() - INTERVAL '3 days'
        AND  status NOT IN ('expired', 'lifetime')
      RETURNING id, name
    `);

    if (expired.rows.length > 0) {
      console.log(
        `[BILLING] Auto-expired ${expired.rows.length} overdue store(s): ` +
        expired.rows.map(r => `"${r.name}"`).join(', ')
      );
    }

    /* Mark payment_status = 'overdue' (already expired above, just keep consistent) */
    await pool.query(`
      UPDATE stores
      SET    payment_status = 'overdue'
      WHERE  is_admin        = FALSE
        AND  payment_status  = 'unpaid'
        AND  payment_due_date IS NOT NULL
        AND  payment_due_date < NOW() - INTERVAL '3 days'
        AND  payment_status  != 'overdue'
    `);

  } catch (err) {
    console.error('[BILLING] Overdue enforcement error:', err.message);
  }
}

/* Export so app.js can call it inside setInterval */
module.exports.runOverdueEnforcement = runOverdueEnforcement;

/* ════════════════════════════════════════
   PER-REQUEST SUBSCRIPTION MIDDLEWARE
════════════════════════════════════════ */
module.exports = async function checkSubscription(req, res, next) {
  const path = req.path.toLowerCase().split('?')[0];

  /* ── 1. Exempt routes ── */
  if (ALWAYS_ALLOW.some(p => path === p || path.startsWith(p + '/'))) return next();

  /* ── 2. Not logged in ── */
  if (!req.session?.storeId) {
    return wantsJson(req)
      ? res.status(401).json({ success: false, message: 'Session expired.', redirect: '/login' })
      : res.redirect('/login');
  }

  try {
    /* ── 3. Always fetch LIVE status from DB ── */
    const { rows } = await pool.query(
      `SELECT status, subscription_end_date, payment_status, payment_due_date
       FROM stores WHERE id = $1 LIMIT 1`,
      [req.session.storeId]
    );

    if (!rows.length) return req.session.destroy(() => res.redirect('/login'));

    const { status, subscription_end_date, payment_status, payment_due_date } = rows[0];

    /* Sync session */
    req.session.storeStatus = status;

    /* Fire-and-forget last_seen */
    pool.query('UPDATE stores SET last_seen = NOW() WHERE id = $1', [req.session.storeId])
      .catch(e => console.error('[checkSubscription] last_seen error:', e.message));

    /* ── 4. Overdue payment check (per-request enforcement) ── */
    if (payment_status === 'unpaid' && payment_due_date && status !== 'lifetime') {
      const daysOverdue = (Date.now() - new Date(payment_due_date).getTime()) / 86400000;

      if (daysOverdue > 3) {
        /* Enforce immediately — update DB and redirect */
        await pool.query(
          "UPDATE stores SET status = 'expired', payment_status = 'overdue' WHERE id = $1",
          [req.session.storeId]
        );
        req.session.storeStatus = 'expired';
        delete req.session.paymentWarning;
        return wantsJson(req)
          ? res.status(403).json({ success: false, message: 'Subscription expired due to non-payment.', redirect: '/expired' })
          : res.redirect('/expired');
      }

      if (daysOverdue >= 1) {
        /* Warning zone (1–3 days overdue): set banner data in session */
        req.session.paymentWarning = {
          daysOverdue:  Math.floor(daysOverdue),
          daysLeft:     Math.ceil(3 - daysOverdue),
          dueDate:      payment_due_date,
        };
      } else {
        /* Not yet overdue but payment_status = unpaid — clear any stale warning */
        delete req.session.paymentWarning;
      }
    } else {
      delete req.session.paymentWarning;
    }

    /* ── 5. Status gate ── */
    if (status === 'pending') {
      return wantsJson(req)
        ? res.status(403).json({ success: false, message: 'Account pending activation.', redirect: '/pending' })
        : res.redirect('/pending');
    }

    /* Trial auto-expiry */
    if (status === 'trial' && subscription_end_date && new Date(subscription_end_date) < new Date()) {
      await pool.query("UPDATE stores SET status = 'expired' WHERE id = $1", [req.session.storeId]);
      req.session.storeStatus = 'expired';
      return wantsJson(req)
        ? res.status(403).json({ success: false, message: 'Trial ended.', redirect: '/expired' })
        : res.redirect('/expired');
    }

    if (status === 'expired') {
      return wantsJson(req)
        ? res.status(403).json({ success: false, message: 'Subscription expired.', redirect: '/expired' })
        : res.redirect('/expired');
    }

    return next();

  } catch (err) {
    console.error('[checkSubscription] DB error:', err.message);
    return next(); /* Fail open */
  }
};

function wantsJson(req) {
  return req.headers['accept']?.includes('application/json') ||
         req.headers['content-type']?.includes('application/json');
}
