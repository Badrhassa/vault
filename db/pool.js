'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', err => console.error('[DB] Pool error:', err.message));
pool.connect((err, client, release) => {
  if (err) { console.error('[DB] Connection failed:', err.message); return; }
  console.log('[DB] PostgreSQL connected ✓');
  release();
});
module.exports = pool;
