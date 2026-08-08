'use strict';

/**
 * routes/api.js  — Store API + check-status endpoint
 * v2: adds category/sku fields, notifications, /api/check-status
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');
const pool    = require('../db/pool');
const checkSubscription    = require('../middleware/checkSubscription');
const { requireAuth }      = require('../middleware/auth');
/* Product limit per subscription plan */
const PLAN_PRODUCT_LIMITS = {
  basic:      200,
  premium:    Infinity,
  enterprise: Infinity,
};
const router = express.Router();

/* ════════════════════════════════════════
   PRODUCT IMAGE UPLOADS
   Saved to public/uploads/products, served
   statically at /uploads/products/<file>.
════════════════════════════════════════ */
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads', 'products');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_IMAGE_EXT  = /\.(jpe?g|png|webp|gif)$/i;
const ALLOWED_IMAGE_MIME = /^image\/(jpeg|png|webp|gif)$/;

const productImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE_EXT.test(path.extname(file.originalname)) ? path.extname(file.originalname).toLowerCase() : '.jpg';
      cb(null, `p_${req.session.storeId}_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 /* 5MB */ },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_EXT.test(path.extname(file.originalname)) && ALLOWED_IMAGE_MIME.test(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'));
  },
});

/* Deletes a previously-uploaded product image file (best-effort, ignores errors). */
function deleteProductImageFile(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/products/')) return;
  const filePath = path.join(__dirname, '..', 'public', imageUrl);
  fs.unlink(filePath, () => {});
}

/* Wraps multer's single-image upload so validation/size errors come back
   as a normal 400 JSON response instead of falling through to a 500. */
function uploadProductImage(req, res, next) {
  productImageUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : err.message;
    res.status(400).json({ success: false, message });
  });
}

/* ════════════════════════════════════════
   GET /api/check-status
   Called by expired.ejs + pending.ejs to
   poll for a status change without page reload.
   NOTE: Exempt from checkSubscription middleware.
════════════════════════════════════════ */
router.get('/check-status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT status, subscription_end_date FROM stores WHERE id=$1 LIMIT 1',
      [req.session.storeId]
    );
    if (!rows.length) return res.json({ status: 'unauthenticated' });

    const { status, subscription_end_date } = rows[0];

    /* Auto-expire trial if needed */
    if (status === 'trial' && subscription_end_date && new Date(subscription_end_date) < new Date()) {
      await pool.query("UPDATE stores SET status='expired' WHERE id=$1", [req.session.storeId]);
      req.session.storeStatus = 'expired';
      return res.json({ status: 'expired' });
    }

    req.session.storeStatus = status;
    res.json({ status });
  } catch (err) {
    console.error('[GET /api/check-status]', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/* All routes below require auth + active subscription */
router.use(requireAuth, checkSubscription);

/* ════════════════════════════════════════
   GET /api/products
════════════════════════════════════════ */
router.get('/products', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, price, stock, category, sku, image_url, created_at FROM products WHERE store_id=$1 ORDER BY created_at DESC',
      [req.session.storeId]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch products.' });
  }
});

/* ════════════════════════════════════════
   POST /api/products
   multipart/form-data: name, price, stock, category?, sku?, image?
════════════════════════════════════════ */
router.post('/products', uploadProductImage, async (req, res) => {
  const { name, price, stock, category, sku } = req.body;
  const storeId     = req.session.storeId;
  const parsedPrice = parseFloat(price);
  const parsedStock = parseInt(stock, 10);

  const fail = (status, message) => {
    if (req.file) deleteProductImageFile(`/uploads/products/${req.file.filename}`);
    return res.status(status).json({ success: false, message });
  };

  if (!name?.trim())                          return fail(400, 'Product name is required.');
  if (isNaN(parsedPrice) || parsedPrice < 0)  return fail(400, 'Price must be a non-negative number.');
  if (isNaN(parsedStock) || parsedStock < 0)  return fail(400, 'Stock must be a non-negative integer.');

  /* ── Enforce product limit based on subscription plan ── */
  try {
    const storeRes = await pool.query(
      'SELECT subscription_plan FROM stores WHERE id = $1 LIMIT 1',
      [storeId]
    );
    const plan  = storeRes.rows[0]?.subscription_plan || 'basic';
    const limit = PLAN_PRODUCT_LIMITS[plan] ?? PLAN_PRODUCT_LIMITS.basic;

    if (limit !== Infinity) {
      const countRes = await pool.query(
        'SELECT COUNT(*)::int AS count FROM products WHERE store_id = $1',
        [storeId]
      );
      if (countRes.rows[0].count >= limit) {
        return fail(403, `وصلت للحد الأقصى لعدد المنتجات في خطتك (${limit}). رقّي خطتك عشان تضيف أكتر.`);
      }
    }
  } catch (err) {
    return fail(500, 'Failed to verify plan limits.');
  }

  const imageUrl = req.file ? `/uploads/products/${req.file.filename}` : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (store_id, name, price, stock, category, sku, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, price, stock, category, sku, image_url, created_at`,
      [storeId, name.trim(), parsedPrice, parsedStock, category?.trim() || null, sku?.trim() || null, imageUrl]
    );
    res.status(201).json({ success: true, product: rows[0] });
  } catch (err) {
    if (imageUrl) deleteProductImageFile(imageUrl);
    res.status(500).json({ success: false, message: 'Failed to add product.' });
  }
});

/* ════════════════════════════════════════
   PATCH /api/products/:id
   multipart/form-data: name?, price?, stock?, category?, sku?, image?, removeImage?
════════════════════════════════════════ */
router.patch('/products/:id', uploadProductImage, async (req, res) => {
  const { name, price, stock, category, sku, removeImage } = req.body;
  const storeId = req.session.storeId;
  const fields = [], values = []; let i = 1;

  if (name     !== undefined) { fields.push(`name     = $${i++}`); values.push(name.trim()); }
  if (price    !== undefined) { fields.push(`price    = $${i++}`); values.push(parseFloat(price)); }
  if (stock    !== undefined) { fields.push(`stock    = $${i++}`); values.push(parseInt(stock, 10)); }
  if (category !== undefined) { fields.push(`category = $${i++}`); values.push(category?.trim() || null); }
  if (sku      !== undefined) { fields.push(`sku      = $${i++}`); values.push(sku?.trim() || null); }

  let newImageUrl;
  if (req.file) {
    newImageUrl = `/uploads/products/${req.file.filename}`;
    fields.push(`image_url = $${i++}`); values.push(newImageUrl);
  } else if (removeImage === 'true') {
    newImageUrl = null;
    fields.push(`image_url = $${i++}`); values.push(null);
  }

  if (!fields.length) {
    if (req.file) deleteProductImageFile(newImageUrl);
    return res.status(400).json({ success: false, message: 'No fields provided for update.' });
  }

  values.push(req.params.id, storeId);
  try {
    const { rows } = await pool.query(
      `SELECT image_url FROM products WHERE id=$${1} AND store_id=$${2}`,
      [req.params.id, storeId]
    );
    const oldImageUrl = rows[0]?.image_url || null;

    const { rows: updated } = await pool.query(
      `UPDATE products SET ${fields.join(', ')}
       WHERE id=$${i} AND store_id=$${i + 1}
       RETURNING id, name, price, stock, category, sku, image_url`,
      values
    );
    if (!updated.length) {
      if (req.file) deleteProductImageFile(newImageUrl);
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    /* Clean up the old file once the new state is safely saved */
    if ((req.file || removeImage === 'true') && oldImageUrl) deleteProductImageFile(oldImageUrl);

    res.json({ success: true, product: updated[0] });
  } catch (err) {
    if (req.file) deleteProductImageFile(newImageUrl);
    res.status(500).json({ success: false, message: 'Failed to update product.' });
  }
});

/* ════════════════════════════════════════
   DELETE /api/products/:id
════════════════════════════════════════ */
router.delete('/products/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM products WHERE id=$1 AND store_id=$2 RETURNING image_url',
      [req.params.id, req.session.storeId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Product not found.' });
    if (rows[0].image_url) deleteProductImageFile(rows[0].image_url);
    res.json({ success: true, message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete product.' });
  }
});

/* ════════════════════════════════════════
   POST /api/sales  — Atomic transaction
   Body: { productId, quantity }
════════════════════════════════════════ */
router.post('/sales', async (req, res) => {
  const { productId, quantity } = req.body;
  const storeId = req.session.storeId;
  const qty     = parseInt(quantity, 10);

  if (!productId || isNaN(qty) || qty < 1)
    return res.status(400).json({ success: false, message: 'Valid productId and quantity (≥1) required.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const prod = await client.query(
      'SELECT id, name, price, stock FROM products WHERE id=$1 AND store_id=$2 FOR UPDATE',
      [productId, storeId]
    );
    if (!prod.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Product not found.' }); }

    const p = prod.rows[0];
    if (p.stock < qty) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: `Only ${p.stock} unit(s) in stock.` }); }

    const unitPrice  = parseFloat(p.price);
    const totalPrice = parseFloat((unitPrice * qty).toFixed(2));
    const newStock   = p.stock - qty;

    await client.query('UPDATE products SET stock=$1 WHERE id=$2', [newStock, productId]);
    const { rows: sale } = await client.query(
      'INSERT INTO sales (store_id,product_id,quantity,unit_price,total_price) VALUES($1,$2,$3,$4,$5) RETURNING id,quantity,total_price,created_at',
      [storeId, productId, qty, unitPrice, totalPrice]
    );
    await client.query('COMMIT');

    res.status(201).json({ success: true, sale: sale[0], newStock, addedRevenue: totalPrice });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('[POST /api/sales]', err.message);
    res.status(500).json({ success: false, message: 'Failed to record sale.' });
  } finally {
    if (client) client.release();
  }
});

/* ════════════════════════════════════════
   GET /api/sales
   Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50
════════════════════════════════════════ */
router.get('/sales', async (req, res) => {
  const storeId = req.session.storeId;
  const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const from    = req.query.from || new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0, 10);
  const to      = req.query.to   || new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await pool.query(
      `SELECT s.id,s.quantity,s.unit_price,s.total_price,s.created_at,p.name AS product_name
       FROM sales s JOIN products p ON p.id=s.product_id
       WHERE s.store_id=$1 AND s.created_at::date BETWEEN $2 AND $3
       ORDER BY s.created_at DESC LIMIT $4`,
      [storeId, from, to, limit]
    );
    res.json({ success: true, sales: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch sales.' });
  }
});

/* ════════════════════════════════════════
   GET /api/stats
════════════════════════════════════════ */
router.get('/stats', async (req, res) => {
  const storeId = req.session.storeId;
  try {
    const { rows } = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(total_price) FROM sales WHERE store_id=$1 AND created_at::date=CURRENT_DATE),0)::NUMERIC(12,2) AS "todaySales",
         COALESCE((SELECT SUM(total_price) FROM sales WHERE store_id=$1 AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW())),0)::NUMERIC(12,2) AS "monthlyRevenue",
         COUNT(CASE WHEN p.stock>0 AND p.stock<=5 THEN 1 END) AS "lowStockCount",
         COUNT(p.id) AS "totalProducts"
       FROM products p WHERE p.store_id=$1`,
      [storeId]
    );
    res.json({ success: true, stats: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats.' });
  }
});

/* ════════════════════════════════════════
   DELETE /api/notifications/:id
   Dismisses an admin notification from the dashboard.
════════════════════════════════════════ */
router.delete('/notifications/:id', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND store_id=$2',
      [req.params.id, req.session.storeId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to dismiss notification.' });
  }
});

module.exports = router;