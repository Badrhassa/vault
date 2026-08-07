'use strict';

const { Pool } = require('pg');

// التحقق مما إذا كان رابط الداتا بيز خارجي يحتاج SSL
const isRemoteDb = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRemoteDb ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', err => console.error('[DB] Pool error:', err.message));

module.exports = pool;