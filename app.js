'use strict';

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const session    = require('express-session');
const pgSession  = require('connect-pg-simple')(session);

const authRouter      = require('./routes/auth');
const apiRouter       = require('./routes/api');
const adminRouter     = require('./routes/admin');
const cashierRouter   = require('./routes/cashier');
const employeesRouter = require('./routes/employees');
const pool            = require('./db/pool');
const { runOverdueEnforcement } = require('./middleware/checkSubscription');

const app = express();

/* ════════════════════════════════════════
   VIEW ENGINE
════════════════════════════════════════ */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1)
/* ════════════════════════════════════════
   BODY PARSING
════════════════════════════════════════ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ════════════════════════════════════════
   SESSION  (PostgreSQL-backed)
════════════════════════════════════════ */
app.set('trust proxy', 1); // 👈 اتأكد إن السطر ده موجود فوق الـ Session على طول (موجود عندك)

app.use(session({
  store: new pgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET, // 👈 اتأكد إنك ضايف المتغير ده في Vercel Environment Variables
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto', // 👈 غيرها من (process.env.NODE_ENV === 'production') لـ 'auto'
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

/* ════════════════════════════════════════
   STATIC FILES
════════════════════════════════════════ */
app.use(express.static(path.join(__dirname, 'public')));

/* ════════════════════════════════════════
   ROUTES
   Order matters:
   1. Landing page  (GET /)
   2. Auth & page routes
   3. API routes
   4. Employee API routes
   5. Admin routes
   6. Cashier routes (separate session namespace)
════════════════════════════════════════ */

/* Landing page — pricing page shown to unauthenticated visitors */
app.get('/', async (req, res) => {
  if (req.session?.storeId)    return res.redirect('/dashboard');
  if (req.session?.employeeId) return res.redirect('/cashier/dashboard');
  try {
    const waRes = await pool.query(
      "SELECT value FROM admin_config WHERE key = 'whatsapp_number' LIMIT 1"
    );
    res.render('landing', { whatsappNumber: waRes.rows[0]?.value || '201021761285' });
  } catch {
    res.render('landing', { whatsappNumber: '201021761285' });
  }
});

app.use('/',              authRouter);
app.use('/api/employees', employeesRouter);
app.use('/api',           apiRouter);
app.use('/admin',         adminRouter);
app.use('/cashier',       cashierRouter);

/* ════════════════════════════════════════
   404
════════════════════════════════════════ */
app.use((req, res) => {
  if (req.accepts('json'))
    return res.status(404).json({ success: false, message: 'Route not found.' });
  res.status(404).send('<h2>404 — Not Found</h2><a href="/dashboard">Go to Dashboard</a>');
});

/* ════════════════════════════════════════
   GLOBAL ERROR HANDLER
════════════════════════════════════════ */
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  if (req.accepts('json'))
    return res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error.' });
  res.status(err.status || 500).send(`<h2>Error ${err.status || 500}</h2><p>${err.message}</p>`);
});

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ⚡  VaultixPOS v4  →  http://localhost:${PORT}`);
  console.log(`  ENV: ${process.env.NODE_ENV || 'development'}\n`);

  /* ════════════════════════════════════════
     AUTOMATED BILLING ENFORCEMENT
     Runs every 30 minutes — no node-cron needed.
     - Auto-expires stores unpaid > 3 days
     - Logs all affected stores to console
     Uses native JS setInterval only.
  ════════════════════════════════════════ */

  /* Run once immediately on startup to catch any missed during downtime */
  //  runOverdueEnforcement()
  //  .then(() => console.log('  ✓  Startup overdue enforcement complete\n'))
  //   .catch(err => console.error('  ✗  Startup enforcement error:', err.message));

  //  /* Then repeat every 30 minutes */
  //  const THIRTY_MIN = 30 * 60 * 1000;
  //  setInterval(async () => {
  //   console.log(`[BILLING] Running scheduled overdue enforcement — ${new Date().toISOString()}`);
  //    await runOverdueEnforcement();
  //  }, THIRTY_MIN);
});

module.exports = app;
