const express = require('express');
const { pool } = require('../db');

const router = express.Router();

/**
 * Middleware: Verify Admin Token
 */
async function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    token = req.headers['x-admin-token'] || req.query?.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: missing admin token' });
  }

  try {
    const sessionRes = await pool.query(`
      SELECT s.*, a.email, a.role
      FROM admin_sessions s
      JOIN admins a ON s.admin_id = a.admin_id
      WHERE s.token = $1 AND s.expires_at > CURRENT_TIMESTAMP
    `, [token]);

    if (sessionRes.rows.length === 0) {
      return res.status(401).json({ error: 'Unauthorized: invalid or expired session' });
    }

    req.admin = sessionRes.rows[0];
    next();
  } catch (err) {
    console.error('Admin auth check failed:', err);
    return res.status(500).json({ error: 'Internal server error during auth check' });
  }
}

// Protect all admin routes with auth middleware
router.use(authenticateAdmin);

/**
 * GET /api/admin/dashboard
 * Gathers complete real-time dashboard data directly from the PostgreSQL database
 */
router.get('/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    // 1. Fetch all products with active reserved stock from live shopping sessions
    const productsQuery = `
      SELECT 
        p.id,
        p.product_id,
        p.tag_uid,
        p.name,
        p.category,
        p.price,
        p.cost,
        p.inventory_qty AS on_hand,
        COALESCE(active_res.reserved_qty, 0) AS reserved,
        p.reorder_level,
        p.safety_stock,
        p.lead_time_days,
        TO_CHAR(p.last_restocked, 'YYYY-MM-DD') AS last_restocked,
        p.supplier,
        p.image_url,
        p.is_active,
        COALESCE(sales_agg.sold_units, 0) AS sold_units,
        COALESCE(sales_agg.revenue, 0) AS revenue
      FROM products p
      LEFT JOIN (
        SELECT ci.product_id, SUM(ci.quantity) AS reserved_qty
        FROM cart_items ci
        JOIN shopping_sessions ss ON ci.session_id = ss.session_id
        WHERE ss.status = 'active'
        GROUP BY ci.product_id
      ) active_res ON p.product_id = active_res.product_id
      LEFT JOIN (
        SELECT sli.product_id, SUM(sli.quantity) AS sold_units, SUM(sli.line_subtotal) AS revenue
        FROM sale_line_items sli
        GROUP BY sli.product_id
      ) sales_agg ON p.product_id = sales_agg.product_id
      ORDER BY p.id ASC;
    `;
    const productsRes = await client.query(productsQuery);
    const productsList = productsRes.rows.map(row => {
      const onHand = parseInt(row.on_hand, 10) || 0;
      const reserved = parseInt(row.reserved, 10) || 0;
      const available = Math.max(0, onHand - reserved);
      return {
        id: row.product_id,
        dbId: row.id,
        rfid: row.tag_uid,
        name: row.name,
        category: row.category || 'General',
        onHand,
        reserved,
        available,
        cost: parseFloat(row.cost) || 0,
        price: parseFloat(row.price) || 0,
        reorderLevel: parseInt(row.reorder_level, 10) || 10,
        safetyStock: parseInt(row.safety_stock, 10) || 5,
        leadTimeDays: parseInt(row.lead_time_days, 10) || 3,
        lastRestocked: row.last_restocked || new Date().toISOString().split('T')[0],
        supplier: row.supplier || 'Standard Vendor',
        soldUnits: parseInt(row.sold_units, 10) || 0,
        revenue: parseFloat(row.revenue) || 0,
        isActive: row.is_active,
      };
    });

    // 2. Fetch Stock Movements Audit Ledger
    const movementsQuery = `
      SELECT 
        sm.id,
        sm.movement_id,
        TO_CHAR(sm.created_at, 'YYYY-MM-DD HH24:MI:SS') AS timestamp,
        sm.product_id,
        p.name AS product_name,
        p.tag_uid AS rfid,
        sm.action,
        sm.delta,
        sm.before_qty,
        sm.after_qty,
        sm.ref_code,
        sm.notes
      FROM stock_movements sm
      LEFT JOIN products p ON sm.product_id = p.product_id
      ORDER BY sm.created_at DESC
      LIMIT 100;
    `;
    const movementsRes = await client.query(movementsQuery);
    const movementsList = movementsRes.rows.map(m => ({
      id: m.movement_id,
      timestamp: m.timestamp,
      productId: m.product_id,
      productName: m.product_name || m.product_id,
      rfid: m.rfid || 'N/A',
      action: m.action,
      delta: parseInt(m.delta, 10),
      beforeQty: parseInt(m.before_qty, 10),
      afterQty: parseInt(m.after_qty, 10),
      ref: m.ref_code || 'DIRECT',
      notes: m.notes || ''
    }));

    // 3. Compute Real KPIs from Database
    const salesStatsRes = await client.query(`
      SELECT 
        COALESCE(SUM(total), 0) AS total_sales,
        COALESCE(SUM(CASE WHEN completed_at::date = CURRENT_DATE THEN total ELSE 0 END), 0) AS today_sales,
        COUNT(*) AS completed_orders
      FROM sales;
    `);
    const salesStats = salesStatsRes.rows[0];

    // Compute gross profit directly from sale_line_items & product cost
    const profitRes = await client.query(`
      SELECT COALESCE(SUM(sli.quantity * (sli.unit_price - COALESCE(p.cost, 0))), 0) AS gross_profit
      FROM sale_line_items sli
      LEFT JOIN products p ON sli.product_id = p.product_id;
    `);
    const grossProfit = parseFloat(profitRes.rows[0].gross_profit) || 0;

    let totalOnHand = 0;
    let totalReserved = 0;
    let totalAssetVal = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;

    productsList.forEach(p => {
      totalOnHand += p.onHand;
      totalReserved += p.reserved;
      totalAssetVal += (p.onHand * p.price);
      if (p.available <= 0) {
        lowStockCount++;
        outOfStockCount++;
      } else if (p.available <= p.reorderLevel) {
        lowStockCount++;
      }
    });

    const todaySales = parseFloat(salesStats.today_sales) > 0 
      ? parseFloat(salesStats.today_sales) 
      : parseFloat(salesStats.total_sales); // Fallback to all-time if none today

    const kpis = {
      todaySales,
      completedOrders: parseInt(salesStats.completed_orders, 10) || 0,
      lowStockCount,
      outOfStockCount,
      grossProfit,
      totalOnHand,
      totalReserved,
      totalAvailable: Math.max(0, totalOnHand - totalReserved),
      totalAssetVal,
      totalSkus: productsList.length
    };

    // 4. Analytics: Category Sales Breakdown from database
    const catSalesRes = await client.query(`
      SELECT 
        COALESCE(p.category, 'Uncategorized') AS category,
        COALESCE(SUM(sli.line_subtotal), 0) AS revenue,
        COALESCE(SUM(sli.quantity), 0) AS units
      FROM sale_line_items sli
      JOIN products p ON sli.product_id = p.product_id
      GROUP BY p.category
      ORDER BY revenue DESC;
    `);

    // 5. Analytics: Top Products from database
    const topProdRes = await client.query(`
      SELECT 
        p.name,
        COALESCE(SUM(sli.line_subtotal), 0) AS revenue,
        COALESCE(SUM(sli.quantity), 0) AS units
      FROM sale_line_items sli
      JOIN products p ON sli.product_id = p.product_id
      GROUP BY p.name
      ORDER BY revenue DESC
      LIMIT 5;
    `);

    // 6. Analytics: Hourly Transaction Volume
    const hourlyRes = await client.query(`
      SELECT 
        TO_CHAR(completed_at, 'HH24:00') AS hour_bucket,
        COUNT(*) AS order_count,
        COALESCE(SUM(total), 0) AS revenue
      FROM sales
      GROUP BY TO_CHAR(completed_at, 'HH24:00')
      ORDER BY hour_bucket ASC;
    `);

    return res.json({
      success: true,
      kpis,
      products: productsList,
      movements: movementsList,
      analytics: {
        categorySales: catSalesRes.rows.map(r => ({
          category: r.category,
          revenue: parseFloat(r.revenue),
          units: parseInt(r.units, 10)
        })),
        topProducts: topProdRes.rows.map(r => ({
          name: r.name,
          revenue: parseFloat(r.revenue),
          units: parseInt(r.units, 10)
        })),
        hourlySales: hourlyRes.rows.map(r => ({
          hour: r.hour_bucket,
          orders: parseInt(r.order_count, 10),
          revenue: parseFloat(r.revenue)
        }))
      }
    });
  } catch (err) {
    console.error('Error fetching admin dashboard data:', err);
    return res.status(500).json({ error: 'Failed to retrieve dashboard data from database' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/products
 * Registers a new product into the database
 */
router.post('/products', async (req, res) => {
  const {
    id, rfid, name, category, supplier,
    cost, price, onHand, reorderLevel, safetyStock, leadTimeDays
  } = req.body;

  if (!id || !name || !rfid) {
    return res.status(400).json({ error: 'Product ID, name, and RFID tag are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertRes = await client.query(`
      INSERT INTO products (
        product_id, tag_uid, name, category, supplier,
        cost, price, inventory_qty, reorder_level, safety_stock, lead_time_days, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
      RETURNING *;
    `, [
      id.trim(),
      rfid.trim(),
      name.trim(),
      category || 'General',
      supplier || 'Standard Vendor',
      parseFloat(cost) || 0,
      parseFloat(price) || 0,
      parseInt(onHand, 10) || 0,
      parseInt(reorderLevel, 10) || 10,
      parseInt(safetyStock, 10) || 5,
      parseInt(leadTimeDays, 10) || 3
    ]);

    // Log initial stock movement if quantity > 0
    if (parseInt(onHand, 10) > 0) {
      const movId = `MOV_${Date.now()}`;
      await client.query(`
        INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
        VALUES ($1, $2, 'RESTOCK', $3, 0, $3, 'INITIAL_INVENTORY', 'Initial registration count')
      `, [movId, id.trim(), parseInt(onHand, 10)]);
    }

    await client.query('COMMIT');
    return res.status(201).json({ success: true, product: insertRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error inserting product:', err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Product ID or RFID Tag already exists in database' });
    }
    return res.status(500).json({ error: 'Database error creating product' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/admin/products/:productId
 * Updates an existing product in the database
 */
router.put('/products/:productId', async (req, res) => {
  const { productId } = req.params;
  const {
    name, rfid, category, supplier, cost, price,
    onHand, reorderLevel, safetyStock, leadTimeDays
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch existing product
    const existing = await client.query('SELECT * FROM products WHERE product_id = $1', [productId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const prevQty = existing.rows[0].inventory_qty;
    const newQty = parseInt(onHand, 10) ?? prevQty;

    const updateRes = await client.query(`
      UPDATE products
      SET name = $1,
          tag_uid = $2,
          category = $3,
          supplier = $4,
          cost = $5,
          price = $6,
          inventory_qty = $7,
          reorder_level = $8,
          safety_stock = $9,
          lead_time_days = $10
      WHERE product_id = $11
      RETURNING *;
    `, [
      name || existing.rows[0].name,
      rfid || existing.rows[0].tag_uid,
      category || existing.rows[0].category,
      supplier || existing.rows[0].supplier,
      parseFloat(cost) ?? existing.rows[0].cost,
      parseFloat(price) ?? existing.rows[0].price,
      newQty,
      parseInt(reorderLevel, 10) ?? existing.rows[0].reorder_level,
      parseInt(safetyStock, 10) ?? existing.rows[0].safety_stock,
      parseInt(leadTimeDays, 10) ?? existing.rows[0].lead_time_days,
      productId
    ]);

    // If quantity was altered directly, record a stock movement
    if (newQty !== prevQty) {
      const delta = newQty - prevQty;
      const movId = `MOV_${Date.now()}`;
      await client.query(`
        INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
        VALUES ($1, $2, 'CYCLE_COUNT', $3, $4, $5, 'ADMIN_EDIT', 'Direct inventory quantity adjustment in catalog')
      `, [movId, productId, delta, prevQty, newQty]);
    }

    await client.query('COMMIT');
    return res.json({ success: true, product: updateRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating product:', err);
    return res.status(500).json({ error: 'Database error updating product' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/cycle-count
 * Logs a physical inventory count audit in the database
 */
router.post('/cycle-count', async (req, res) => {
  const { productId, countedQty, reason, notes } = req.body;

  if (!productId || countedQty === undefined || isNaN(countedQty)) {
    return res.status(400).json({ error: 'productId and countedQty are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT inventory_qty FROM products WHERE product_id = $1', [productId]);
    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const beforeQty = prodRes.rows[0].inventory_qty;
    const afterQty = parseInt(countedQty, 10);
    const delta = afterQty - beforeQty;

    await client.query('UPDATE products SET inventory_qty = $1 WHERE product_id = $2', [afterQty, productId]);

    const movId = `MOV_${Date.now()}`;
    await client.query(`
      INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
      VALUES ($1, $2, 'CYCLE_COUNT', $3, $4, $5, $6, $7)
    `, [movId, productId, delta, beforeQty, afterQty, `AUDIT-${(reason || 'FLOOR').toUpperCase()}`, notes || 'Cycle count verified physical ledger']);

    await client.query('COMMIT');
    return res.json({ success: true, delta, beforeQty, afterQty });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error recording cycle count:', err);
    return res.status(500).json({ error: 'Database error recording cycle count' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/admin/restock
 * Logs inbound replenishment or damage writeoff in the database
 */
router.post('/restock', async (req, res) => {
  const { productId, type, quantity, poNumber, notes } = req.body;

  if (!productId || !quantity || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'productId and valid positive quantity are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT inventory_qty FROM products WHERE product_id = $1', [productId]);
    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const beforeQty = prodRes.rows[0].inventory_qty;
    const qty = parseInt(quantity, 10);
    let delta = qty;
    let action = 'RESTOCK';

    if (type === 'DAMAGE_WRITEOFF') {
      delta = -Math.min(qty, beforeQty);
      action = 'DAMAGE_WRITEOFF';
    } else if (type === 'RETURN_RESTOCK') {
      action = 'RETURN_RESTOCK';
    }

    const afterQty = Math.max(0, beforeQty + delta);

    await client.query(`
      UPDATE products
      SET inventory_qty = $1,
          last_restocked = CASE WHEN $2 > 0 THEN CURRENT_DATE ELSE last_restocked END
      WHERE product_id = $3
    `, [afterQty, delta, productId]);

    const movId = `MOV_${Date.now()}`;
    await client.query(`
      INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [movId, productId, action, delta, beforeQty, afterQty, poNumber || 'PO-DIRECT', notes || `${action} processed`]);

    await client.query('COMMIT');
    return res.json({ success: true, action, delta, beforeQty, afterQty });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error processing restock:', err);
    return res.status(500).json({ error: 'Database error processing restock' });
  } finally {
    client.release();
  }
});

/**
 * PUT /api/admin/thresholds/:productId
 * Updates reorder rules in the database
 */
router.put('/thresholds/:productId', async (req, res) => {
  const { productId } = req.params;
  const { reorderLevel, safetyStock, supplier, leadTimeDays } = req.body;

  try {
    const result = await pool.query(`
      UPDATE products
      SET reorder_level = $1,
          safety_stock = $2,
          supplier = $3,
          lead_time_days = $4
      WHERE product_id = $5
      RETURNING *;
    `, [
      parseInt(reorderLevel, 10) || 10,
      parseInt(safetyStock, 10) || 5,
      supplier || 'General Supplier',
      parseInt(leadTimeDays, 10) || 3,
      productId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.json({ success: true, product: result.rows[0] });
  } catch (err) {
    console.error('Error updating thresholds:', err);
    return res.status(500).json({ error: 'Database error updating thresholds' });
  }
});

module.exports = router;
