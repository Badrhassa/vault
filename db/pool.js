'use strict';

const { Pool } = require('pg');

// استخدام المتغير المحدد في Vercel مباشرة
const connectionString = process.env.POSTGRES_DATABASE_POSTGRES_URL || process.env.POSTGRES_URL;

console.log('[DB CONNECTING TO]:', connectionString ? connectionString.split('@')[1] : 'NOT FOUND');

const isLocal = connectionString && (connectionString.includes('localhost') || connectionString.includes('127.0.0.1'));

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', err => console.error('[DB] Pool error:', err.message));

module.exports = pool;