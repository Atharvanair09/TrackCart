const express = require('express');
const { pool } = require('../db');
const {
  calculateMarketBasket,
  getSimulatedMarketBasket,
  calculateDemandForecast,
  getSimulatedDemandForecast,
  calculateExpiryIntelligence,
  getSimulatedExpiryData
} = require('../services/analytics');

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
 * Helper: Build Product List with active reservations and sales aggregation
 */
async function getProductsCatalog(client) {
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
      COALESCE(p.target_coverage_days, 14) AS target_coverage_days,
      TO_CHAR(p.last_restocked, 'YYYY-MM-DD') AS last_restocked,
      TO_CHAR(p.expiry_date, 'YYYY-MM-DD') AS expiry_date,
      p.batch_number,
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
  return productsRes.rows.map(row => {
    const onHand = parseInt(row.on_hand, 10) || 0;
    const reserved = parseInt(row.reserved, 10) || 0;
    const available = Math.max(0, onHand - reserved);
    const reorderLevel = parseInt(row.reorder_level, 10) || 10;
    const safetyStock = parseInt(row.safety_stock, 10) || 5;

    let status = 'In Stock';
    if (available <= 0) status = 'Out of Stock';
    else if (available <= reorderLevel) status = 'Low Stock';

    return {
      id: row.product_id,
      dbId: row.id,
      rfid: row.tag_uid,
      name: row.name,
      category: row.category || 'General',
      onHand,
      reserved,
      available,
      status,
      cost: parseFloat(row.cost) || 0,
      price: parseFloat(row.price) || 0,
      reorderLevel,
      safetyStock,
      leadTimeDays: parseInt(row.lead_time_days, 10) || 3,
      targetCoverageDays: parseInt(row.target_coverage_days, 10) || 14,
      lastRestocked: row.last_restocked || new Date().toISOString().split('T')[0],
      expiryDate: row.expiry_date || null,
      batchNumber: row.batch_number || null,
      supplier: row.supplier || 'Standard Vendor',
      soldUnits: parseInt(row.sold_units, 10) || 0,
      revenue: parseFloat(row.revenue) || 0,
      isActive: row.is_active,
    };
  });
}

/**
 * GET /api/admin/dashboard
 * Gathers complete real-time dashboard data directly from the PostgreSQL database
 */
router.get('/dashboard', async (req, res) => {
  const client = await pool.connect();
  try {
    const isDemo = req.query.demo === 'true';

    // 1. Fetch products with active reservations & sales
    const productsList = await getProductsCatalog(client);

    // 2. Fetch stock movements audit ledger
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

    // 3. Compute Real KPIs
    const salesStatsRes = await client.query(`
      SELECT 
        COALESCE(SUM(total), 0) AS total_sales,
        COALESCE(SUM(CASE WHEN completed_at::date = CURRENT_DATE THEN total ELSE 0 END), 0) AS today_sales,
        COUNT(*) AS completed_orders
      FROM sales;
    `);
    const salesStats = salesStatsRes.rows[0];

    const activeCartsRes = await client.query(
      `SELECT COUNT(*) AS active_carts FROM shopping_sessions WHERE status = 'active'`
    );
    const activeCartsCount = parseInt(activeCartsRes.rows[0]?.active_carts, 10) || 0;

    const profitRes = await client.query(`
      SELECT COALESCE(SUM(sli.quantity * (sli.unit_price - COALESCE(p.cost, 0))), 0) AS gross_profit
      FROM sale_line_items sli
      LEFT JOIN products p ON sli.product_id = p.product_id;
    `);
    const grossProfit = parseFloat(profitRes.rows[0]?.gross_profit) || 0;

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

    const totalAvailable = Math.max(0, totalOnHand - totalReserved);
    const todaySales = parseFloat(salesStats.today_sales);

    // 4. Calculate Demand Forecast & Intelligence for each product
    const forecastList = calculateDemandForecast(productsList, 30);
    const forecastMap = new Map();
    forecastList.forEach(f => forecastMap.set(f.id, f));

    // Attach forecast to products
    productsList.forEach(p => {
      const f = forecastMap.get(p.id);
      if (f) {
        p.avgDailySales = f.avgDailySales;
        p.daysUntilStockout = f.daysUntilStockout;
        p.stockoutDate = f.stockoutDate;
        p.targetStock = f.targetStock;
        p.suggestedReorderQty = f.suggestedReorderQty;
        p.classification = f.classification;
        p.recommendationReason = f.recommendationReason;
      }
    });

    // 5. Build Store Insights & Alerts
    const lowStockAlerts = productsList
      .filter(p => p.available <= p.reorderLevel)
      .map(p => ({
        id: p.id,
        name: p.name,
        available: p.available,
        reorderLevel: p.reorderLevel,
        suggestedReorderQty: p.suggestedReorderQty || Math.max(10, p.reorderLevel * 2 - p.available),
        status: p.available === 0 ? 'Out of Stock' : 'Low Stock'
      }));

    const stockoutRisk = forecastList
      .filter(f => f.daysUntilStockout <= 7 && f.daysUntilStockout > 0)
      .map(f => ({
        id: f.id,
        name: f.name,
        available: f.available,
        daysUntilStockout: f.daysUntilStockout,
        stockoutDate: f.stockoutDate,
        leadTimeDays: f.leadTimeDays
      }));

    // Check expiry
    const expiringSoon = productsList
      .filter(p => {
        if (!p.expiryDate) return false;
        const diff = Math.ceil((new Date(p.expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
        return diff <= 30;
      })
      .map(p => {
        const diff = Math.ceil((new Date(p.expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
        return {
          id: p.id,
          name: p.name,
          expiryDate: p.expiryDate,
          batchNumber: p.batchNumber || 'LOT-DIRECT',
          daysUntilExpiry: diff,
          available: p.available,
          isExpired: diff < 0
        };
      });

    const slowMoving = forecastList
      .filter(f => f.classification === 'Slow Moving' || f.classification === 'Dormant Stock')
      .slice(0, 5);

    const reorderRecommendations = forecastList
      .filter(f => f.suggestedReorderQty > 0)
      .map(f => ({
        id: f.id,
        name: f.name,
        available: f.available,
        targetStock: f.targetStock,
        suggestedQty: f.suggestedReorderQty,
        supplier: f.supplier,
        leadTimeDays: f.leadTimeDays,
        reason: f.recommendationReason
      }));

    // Fetch market basket combos
    let suggestedCombos = [];
    if (isDemo) {
      suggestedCombos = getSimulatedMarketBasket(productsList).combos.slice(0, 3);
    } else {
      // Query completed transactions
      const txRows = await client.query(`
        SELECT sli.sale_id, sli.product_id, p.name
        FROM sale_line_items sli
        JOIN sales s ON sli.sale_id = s.sale_id
        JOIN products p ON sli.product_id = p.product_id
        ORDER BY sli.sale_id
      `);
      const txMap = new Map();
      txRows.rows.forEach(r => {
        if (!txMap.has(r.sale_id)) txMap.set(r.sale_id, { sale_id: r.sale_id, items: [] });
        txMap.get(r.sale_id).items.push({ product_id: r.product_id, name: r.name });
      });
      const basket = calculateMarketBasket(Array.from(txMap.values()), productsList);
      suggestedCombos = basket.combos.length > 0
        ? basket.combos.slice(0, 3)
        : getSimulatedMarketBasket(productsList).combos.slice(0, 3);
    }

    // 6. Synthesize "Today's Priorities"
    const priorities = [];
    if (lowStockAlerts.length > 0) {
      const topLow = lowStockAlerts[0];
      const fc = forecastMap.get(topLow.id);
      const days = fc ? fc.daysUntilStockout : 3;
      priorities.push({
        id: 'prio-reorder',
        type: 'reorder',
        badge: 'Reorder Urgently',
        priority: 'high',
        title: `Reorder ${topLow.name}`,
        subtitle: `Approximately ${days <= 0 ? 0 : days} days of stock remaining (${topLow.available} units on shelf). Recommended reorder: ${topLow.suggestedReorderQty} units.`,
        targetTab: 'forecasting',
        targetId: topLow.id,
        actionLabel: 'Review Reorder'
      });
    }

    if (expiringSoon.length > 0) {
      const topExp = expiringSoon[0];
      priorities.push({
        id: 'prio-expiry',
        type: 'expiry',
        badge: topExp.isExpired ? 'Expired Stock' : 'Expiry Approaching',
        priority: topExp.isExpired ? 'danger' : 'medium',
        title: topExp.isExpired ? `Remove Expired ${topExp.name}` : `Review ${topExp.name} Expiry`,
        subtitle: topExp.isExpired
          ? `Product expired on ${topExp.expiryDate}. Write off ${topExp.available} units immediately.`
          : `Approaching expiry in ${topExp.daysUntilExpiry} days (${topExp.available} units). Consider a 15-25% promo discount.`,
        targetTab: 'expiry',
        targetId: topExp.id,
        actionLabel: 'Inspect Expiry'
      });
    } else {
      // Demo priority if real expiry has no criticals
      priorities.push({
        id: 'prio-expiry-healthy',
        type: 'expiry',
        badge: 'Shelf Life Monitor',
        priority: 'normal',
        title: 'Batch Shelf-Life Audit',
        subtitle: 'All active batches within optimal shelf-life window. Zero expired inventory on floor.',
        targetTab: 'expiry',
        actionLabel: 'View Expiry Tracker'
      });
    }

    if (slowMoving.length > 0) {
      const topSlow = slowMoving[0];
      priorities.push({
        id: 'prio-promo',
        type: 'promotion',
        badge: 'Promote Slow Mover',
        priority: 'normal',
        title: `Consider Promotion for ${topSlow.name}`,
        subtitle: `Low recent velocity with ${topSlow.available} units in stock. Recommend a 10% promotional discount or bundle offer.`,
        targetTab: 'expiry',
        targetId: topSlow.id,
        actionLabel: 'Create Promotion'
      });
    }

    if (suggestedCombos.length > 0) {
      const topCombo = suggestedCombos[0];
      priorities.push({
        id: 'prio-combo',
        type: 'combo',
        badge: 'Market Basket Synergy',
        priority: 'normal',
        title: `Suggested Combo: ${topCombo.title}`,
        subtitle: `Frequently co-purchased in ${topCombo.transactions} transactions (Lift ${topCombo.lift}x). Recommended for cart cross-sell.`,
        targetTab: 'basket',
        actionLabel: 'View Basket Analysis'
      });
    }

    // 7. Recent Activity (Combines sales and movements)
    const recentActivity = movementsList.slice(0, 6);

    const kpis = {
      totalProducts: productsList.length,
      availableStock: totalAvailable,
      activeShoppingCarts: activeCartsCount,
      todaySales,
      completedOrders: parseInt(salesStats.completed_orders, 10) || 0,
      lowStockCount,
      outOfStockCount,
      grossProfit,
      totalOnHand,
      totalReserved,
      totalAssetVal
    };

    return res.json({
      success: true,
      kpis,
      storeInsights: {
        lowStock: lowStockAlerts,
        stockoutRisk,
        expiringSoon,
        slowMoving,
        reorderRecommendations,
        suggestedCombos,
        recentActivity
      },
      todaysPriorities: priorities,
      products: productsList,
      movements: movementsList
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
    cost, price, onHand, reorderLevel, safetyStock, leadTimeDays,
    targetCoverageDays, expiryDate, batchNumber
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
        cost, price, inventory_qty, reorder_level, safety_stock, lead_time_days,
        target_coverage_days, expiry_date, batch_number, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true)
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
      parseInt(leadTimeDays, 10) || 3,
      parseInt(targetCoverageDays, 10) || 14,
      expiryDate || null,
      batchNumber || null
    ]);

    if (parseInt(onHand, 10) > 0) {
      const movId = `MOV_${Date.now()}`;
      await client.query(`
        INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
        VALUES ($1, $2, 'RESTOCK', $3, 0, $3, 'INITIAL_INVENTORY', 'Initial registration count')
      `, [movId, id.trim(), parseInt(onHand, 10)]);

      if (batchNumber && expiryDate) {
        const batchId = `BATCH_${Date.now()}`;
        await client.query(`
          INSERT INTO product_batches (batch_id, product_id, batch_number, quantity, expiry_date, supplier)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [batchId, id.trim(), batchNumber, parseInt(onHand, 10), expiryDate, supplier || 'Standard Vendor']);
      }
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
    onHand, reorderLevel, safetyStock, leadTimeDays,
    targetCoverageDays, expiryDate, batchNumber
  } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM products WHERE product_id = $1', [productId]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const prevQty = existing.rows[0].inventory_qty;
    const newQty = (onHand !== undefined && onHand !== null && onHand !== '') ? parseInt(onHand, 10) : prevQty;

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
          lead_time_days = $10,
          target_coverage_days = $11,
          expiry_date = COALESCE($12, expiry_date),
          batch_number = COALESCE($13, batch_number)
      WHERE product_id = $14
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
      parseInt(targetCoverageDays, 10) ?? existing.rows[0].target_coverage_days,
      expiryDate || null,
      batchNumber || null,
      productId
    ]);

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

    // Check that afterQty does not drop below active reserved stock
    const resRes = await client.query(`
      SELECT COALESCE(SUM(ci.quantity), 0) AS reserved_qty
      FROM cart_items ci
      JOIN shopping_sessions ss ON ci.session_id = ss.session_id
      WHERE ss.status = 'active' AND ci.product_id = $1
    `, [productId]);
    const reservedQty = parseInt(resRes.rows[0]?.reserved_qty, 10) || 0;

    if (afterQty < reservedQty) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot reduce physical inventory to ${afterQty}: ${reservedQty} units are currently reserved in active customer shopping carts.`
      });
    }

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
 * Handles Inbound Replenishment, Returns, and Damaged Write-offs with safety checks
 */
router.post('/restock', async (req, res) => {
  const { productId, type, quantity, poNumber, batchNumber, expiryDate, supplier, notes } = req.body;

  if (!productId || !quantity || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: 'productId and valid positive quantity are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const prodRes = await client.query('SELECT * FROM products WHERE product_id = $1', [productId]);
    if (prodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Product not found' });
    }

    const beforeQty = prodRes.rows[0].inventory_qty;
    const qty = parseInt(quantity, 10);
    let delta = qty;
    let action = 'RESTOCK';

    if (type === 'DAMAGE_WRITEOFF') {
      action = 'DAMAGE_WRITEOFF';
      // Verify damage writeoff does not consume stock reserved by active shopping carts
      const resRes = await client.query(`
        SELECT COALESCE(SUM(ci.quantity), 0) AS reserved_qty
        FROM cart_items ci
        JOIN shopping_sessions ss ON ci.session_id = ss.session_id
        WHERE ss.status = 'active' AND ci.product_id = $1
      `, [productId]);
      const reservedQty = parseInt(resRes.rows[0]?.reserved_qty, 10) || 0;

      if (beforeQty - qty < reservedQty) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Cannot write off ${qty} units: ${reservedQty} units are currently reserved by active shopping carts. Maximum deductible is ${Math.max(0, beforeQty - reservedQty)} units.`
        });
      }

      delta = -Math.min(qty, beforeQty);
    } else if (type === 'RETURN_RESTOCK') {
      action = 'RETURN_RESTOCK';
      delta = qty;
    }

    const afterQty = Math.max(0, beforeQty + delta);

    // Update product inventory & metadata
    await client.query(`
      UPDATE products
      SET inventory_qty = $1,
          last_restocked = CASE WHEN $2 > 0 THEN CURRENT_DATE ELSE last_restocked END,
          expiry_date = CASE WHEN $3::date IS NOT NULL THEN $3::date ELSE expiry_date END,
          batch_number = CASE WHEN $4::text IS NOT NULL THEN $4::text ELSE batch_number END,
          supplier = CASE WHEN $5::text IS NOT NULL THEN $5::text ELSE supplier END
      WHERE product_id = $6
    `, [afterQty, delta, expiryDate || null, batchNumber || null, supplier || null, productId]);

    // Record lot in product_batches if restock has batch info
    if (delta > 0 && batchNumber && expiryDate) {
      const batchId = `BATCH_${Date.now()}`;
      await client.query(`
        INSERT INTO product_batches (batch_id, product_id, batch_number, quantity, expiry_date, supplier)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [batchId, productId, batchNumber, qty, expiryDate, supplier || prodRes.rows[0].supplier || 'Vendor']);
    }

    // Record stock movement audit
    const movId = `MOV_${Date.now()}`;
    await client.query(`
      INSERT INTO stock_movements (movement_id, product_id, action, delta, before_qty, after_qty, ref_code, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [movId, productId, action, delta, beforeQty, afterQty, poNumber || 'PO-DIRECT', notes || `${action} processed`]);

    await client.query('COMMIT');
    return res.json({
      success: true,
      action,
      delta,
      beforeQty,
      afterQty,
      productId,
      poNumber: poNumber || 'PO-DIRECT'
    });
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
 * Updates reorder rules and target inventory coverage in the database
 */
router.put('/thresholds/:productId', async (req, res) => {
  const { productId } = req.params;
  const { reorderLevel, safetyStock, supplier, leadTimeDays, targetCoverageDays } = req.body;

  try {
    const result = await pool.query(`
      UPDATE products
      SET reorder_level = $1,
          safety_stock = $2,
          supplier = $3,
          lead_time_days = $4,
          target_coverage_days = $5
      WHERE product_id = $6
      RETURNING *;
    `, [
      parseInt(reorderLevel, 10) || 10,
      parseInt(safetyStock, 10) || 5,
      supplier || 'General Supplier',
      parseInt(leadTimeDays, 10) || 3,
      parseInt(targetCoverageDays, 10) || 14,
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

/**
 * GET /api/admin/expiry
 * Expiry tracking and smart offer recommendations
 */
router.get('/expiry', async (req, res) => {
  const isDemo = req.query.demo === 'true';
  const client = await pool.connect();
  try {
    const products = await getProductsCatalog(client);

    if (isDemo) {
      const demoData = getSimulatedExpiryData(products);
      return res.json({ success: true, ...demoData });
    }

    // Query product batches
    const batchesRes = await client.query(`
      SELECT pb.*, p.name AS product_name
      FROM product_batches pb
      JOIN products p ON pb.product_id = p.product_id
      WHERE pb.status = 'active'
      ORDER BY pb.expiry_date ASC
    `);

    const result = calculateExpiryIntelligence(products, batchesRes.rows);

    // If real database has no expiry entries yet, indicate clearly
    if (result.items.length === 0) {
      return res.json({
        success: true,
        items: [],
        isSimulated: false,
        message: 'No expiry dates recorded yet in production database. Receive stock with batch/expiry dates or switch to Demo Mode to evaluate tracking.'
      });
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error fetching expiry data:', err);
    return res.status(500).json({ error: 'Failed to retrieve expiry intelligence' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/promotions
 * Returns active and recommended promotional offers
 */
router.get('/promotions', async (req, res) => {
  try {
    const promosRes = await pool.query(`
      SELECT pp.*, p.name AS product_name, p.price, p.category
      FROM product_promotions pp
      JOIN products p ON pp.product_id = p.product_id
      ORDER BY pp.created_at DESC
    `);
    return res.json({ success: true, promotions: promosRes.rows });
  } catch (err) {
    console.error('Error fetching promotions:', err);
    return res.status(500).json({ error: 'Failed to retrieve promotions' });
  }
});

/**
 * POST /api/admin/promotions
 * Creates or approves a promotional discount rule
 */
router.post('/promotions', async (req, res) => {
  const { productId, discountPercent, reason, expiresAt } = req.body;

  if (!productId || !discountPercent || isNaN(discountPercent)) {
    return res.status(400).json({ error: 'productId and discountPercent are required' });
  }

  const promoId = `PROMO_${Date.now()}`;
  try {
    const insertRes = await pool.query(`
      INSERT INTO product_promotions (promo_id, product_id, discount_percent, reason, status, expires_at)
      VALUES ($1, $2, $3, $4, 'active', $5)
      RETURNING *;
    `, [promoId, productId, parseFloat(discountPercent), reason || 'Smart promotional discount', expiresAt || null]);

    return res.status(201).json({ success: true, promotion: insertRes.rows[0] });
  } catch (err) {
    console.error('Error creating promotion:', err);
    return res.status(500).json({ error: 'Database error creating promotion' });
  }
});

/**
 * GET /api/admin/market-basket
 * Market Basket Analysis: Support, Confidence, Lift & Combo recommendations
 */
router.get('/market-basket', async (req, res) => {
  const isDemo = req.query.demo === 'true';
  const client = await pool.connect();
  try {
    const products = await getProductsCatalog(client);

    if (isDemo) {
      const demoData = getSimulatedMarketBasket(products);
      return res.json({ success: true, ...demoData });
    }

    // Query real completed sales transactions
    const txRows = await client.query(`
      SELECT sli.sale_id, sli.product_id, p.name, p.category, p.price
      FROM sale_line_items sli
      JOIN sales s ON sli.sale_id = s.sale_id
      JOIN products p ON sli.product_id = p.product_id
      ORDER BY sli.sale_id
    `);

    const txMap = new Map();
    txRows.rows.forEach(r => {
      if (!txMap.has(r.sale_id)) txMap.set(r.sale_id, { sale_id: r.sale_id, items: [] });
      txMap.get(r.sale_id).items.push({ product_id: r.product_id, name: r.name, category: r.category });
    });

    const transactions = Array.from(txMap.values());
    const basketResult = calculateMarketBasket(transactions, products);

    // If transactions are fewer than 2, offer clear explanation
    if (transactions.length < 2) {
      basketResult.message = `Insufficient completed sales transactions in production database (${transactions.length} found). Switch to Demo Mode to explore multi-transaction market basket associations and lift calculations.`;
    }

    return res.json({ success: true, ...basketResult });
  } catch (err) {
    console.error('Error calculating market basket:', err);
    return res.status(500).json({ error: 'Failed to compute market basket analysis' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/demand-forecast
 * Demand velocity, stockout predictions, and replenishment reorder rules
 */
router.get('/demand-forecast', async (req, res) => {
  const isDemo = req.query.demo === 'true';
  const { window = 30 } = req.query;
  const client = await pool.connect();
  try {
    const products = await getProductsCatalog(client);

    if (isDemo) {
      const demoForecast = getSimulatedDemandForecast(products);
      return res.json({ success: true, ...demoForecast });
    }

    const forecast = calculateDemandForecast(products, parseInt(window, 10) || 30);
    return res.json({ success: true, forecast, isSimulated: false });
  } catch (err) {
    console.error('Error calculating demand forecast:', err);
    return res.status(500).json({ error: 'Failed to compute demand forecast' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/admin/sessions
 * Returns shopping sessions (active, completed, cancelled) with their cart items
 */
router.get('/sessions', async (req, res) => {
  const { status = 'ALL', limit = 50 } = req.query;
  try {
    const whereClause = status !== 'ALL' ? `WHERE ss.status = $1` : '';
    const params = status !== 'ALL' ? [status] : [];

    const sessRes = await pool.query(`
      SELECT
        ss.session_id,
        ss.cart_id,
        ss.user_id,
        ss.status,
        TO_CHAR(ss.started_at, 'YYYY-MM-DD HH24:MI:SS') AS started_at,
        TO_CHAR(ss.ended_at, 'YYYY-MM-DD HH24:MI:SS') AS ended_at,
        COALESCE(item_agg.item_count, 0) AS item_count,
        COALESCE(item_agg.subtotal, 0) AS subtotal,
        s.sale_id
      FROM shopping_sessions ss
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS item_count, SUM(subtotal) AS subtotal
        FROM cart_items
        GROUP BY session_id
      ) item_agg ON ss.session_id = item_agg.session_id
      LEFT JOIN sales s ON ss.session_id = s.session_id
      ${whereClause}
      ORDER BY ss.started_at DESC
      LIMIT ${parseInt(limit, 10) || 50}
    `, params);

    const sessions = sessRes.rows;
    for (const sess of sessions) {
      const itemsRes = await pool.query(`
        SELECT ci.product_id, ci.quantity, ci.unit_price_at_addition, ci.subtotal, p.name, p.category
        FROM cart_items ci
        JOIN products p ON ci.product_id = p.product_id
        WHERE ci.session_id = $1
      `, [sess.session_id]);
      sess.items = itemsRes.rows;
    }

    return res.json({ success: true, sessions });
  } catch (err) {
    console.error('Error fetching sessions:', err);
    return res.status(500).json({ error: 'Failed to retrieve sessions' });
  }
});

/**
 * GET /api/admin/sales
 * Returns completed sales records with line items
 */
router.get('/sales', async (req, res) => {
  const { limit = 100, startDate, endDate } = req.query;
  try {
    let whereClause = '';
    const params = [];
    if (startDate && endDate) {
      whereClause = `WHERE s.completed_at >= $1 AND s.completed_at < $2::date + interval '1 day'`;
      params.push(startDate, endDate);
    }

    const salesRes = await pool.query(`
      SELECT
        s.sale_id,
        s.session_id,
        s.subtotal,
        s.tax_rate,
        s.tax_amount,
        s.total,
        TO_CHAR(s.completed_at, 'YYYY-MM-DD HH24:MI:SS') AS completed_at,
        COALESCE(li_agg.item_count, 0) AS item_count
      FROM sales s
      LEFT JOIN (
        SELECT sale_id, SUM(quantity) AS item_count
        FROM sale_line_items
        GROUP BY sale_id
      ) li_agg ON s.sale_id = li_agg.sale_id
      ${whereClause}
      ORDER BY s.completed_at DESC
      LIMIT ${parseInt(limit, 10) || 100}
    `, params);

    const sales = salesRes.rows;
    for (const sale of sales) {
      const liRes = await pool.query(`
        SELECT sli.product_id, sli.quantity, sli.unit_price, sli.line_subtotal, p.name, p.category
        FROM sale_line_items sli
        JOIN products p ON sli.product_id = p.product_id
        WHERE sli.sale_id = $1
      `, [sale.sale_id]);
      sale.lineItems = liRes.rows;
    }

    const totalsRes = await pool.query(`
      SELECT
        COUNT(*) AS total_sales,
        COALESCE(SUM(total), 0) AS total_revenue,
        COALESCE(SUM(tax_amount), 0) AS total_tax
      FROM sales
      ${whereClause}
    `, params);

    return res.json({
      success: true,
      sales,
      totals: {
        count: parseInt(totalsRes.rows[0].total_sales, 10),
        revenue: parseFloat(totalsRes.rows[0].total_revenue),
        tax: parseFloat(totalsRes.rows[0].total_tax)
      }
    });
  } catch (err) {
    console.error('Error fetching sales:', err);
    return res.status(500).json({ error: 'Failed to retrieve sales data' });
  }
});

/**
 * GET /api/admin/analytics
 * Multi-graph analytics across Sales, Inventory, Expiry, and Market Basket
 */
router.get('/analytics', async (req, res) => {
  const isDemo = req.query.demo === 'true';
  const { granularity = 'daily', startDate, endDate } = req.query;

  const client = await pool.connect();
  try {
    const products = await getProductsCatalog(client);

    if (isDemo) {
      // 18 complete chart datasets generated for demonstration mode
      const now = new Date();
      const timeSeries = [];
      const unitSeries = [];
      const aovSeries = [];

      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const dayStr = d.toISOString().split('T')[0];
        const orders = Math.floor(15 + Math.sin(i) * 6 + Math.random() * 5);
        const rev = Number((orders * (32 + Math.random() * 12)).toFixed(2));
        const units = Math.floor(orders * 2.8);
        timeSeries.push({ bucket: dayStr, orders, revenue: rev });
        unitSeries.push({ bucket: dayStr, units });
        aovSeries.push({ bucket: dayStr, aov: Number((rev / orders).toFixed(2)) });
      }

      const categorySales = [
        { category: 'Beverages', revenue: 4120.50, units: 820 },
        { category: 'Snacks', revenue: 3480.20, units: 950 },
        { category: 'Electronics', revenue: 5240.00, units: 140 },
        { category: 'Accessories', revenue: 2190.80, units: 210 }
      ];

      const topProducts = [
        { id: 'PROD-004', name: 'Wireless Earbuds', revenue: 3119.22, units: 78 },
        { id: 'PROD-005', name: 'Cold Brew Coffee 330ml', revenue: 2680.50, units: 672 },
        { id: 'PROD-008', name: 'Electrolyte Energy Drink', revenue: 2150.80, units: 720 },
        { id: 'PROD002', name: 'Organic Granola Bar', revenue: 1980.40, units: 795 },
        { id: 'PROD-009', name: 'Bluetooth Tracker Tag', revenue: 1874.25, units: 75 }
      ];

      const stockDistribution = products.map(p => ({
        name: p.name,
        onHand: p.onHand,
        reserved: p.reserved,
        available: p.available
      }));

      const inventoryMovements = [
        { action: 'RESTOCK', count: 18, totalUnits: 420 },
        { action: 'CHECKOUT', count: 85, totalUnits: 280 },
        { action: 'CYCLE_COUNT', count: 6, totalUnits: -8 },
        { action: 'DAMAGE_WRITEOFF', count: 3, totalUnits: -5 }
      ];

      const expiryStatusChart = [
        { label: 'Healthy (> 30 Days)', count: 6, units: 145 },
        { label: 'Expiring in 30 Days', count: 2, units: 40 },
        { label: 'Expiring in 7 Days', count: 1, units: 14 },
        { label: 'Expired', count: 0, units: 0 }
      ];

      const basketPairs = getSimulatedMarketBasket(products).pairs.slice(0, 6);

      return res.json({
        success: true,
        isSimulated: true,
        timeSeries,
        unitSeries,
        aovSeries,
        categorySales,
        topProducts,
        stockDistribution,
        inventoryMovements,
        expiryStatusChart,
        basketPairs,
        activeSessions: 4
      });
    }

    // Real PostgreSQL calculations
    let dateTrunc = 'day';
    if (granularity === 'weekly') dateTrunc = 'week';
    if (granularity === 'monthly') dateTrunc = 'month';

    let dateFilter = '';
    const params = [];
    if (startDate && endDate) {
      dateFilter = `WHERE completed_at >= $1 AND completed_at < $2::date + interval '1 day'`;
      params.push(startDate, endDate);
    }

    const timeSeriesRes = await client.query(`
      SELECT
        DATE_TRUNC('${dateTrunc}', completed_at) AS bucket,
        COUNT(*) AS order_count,
        COALESCE(SUM(total), 0) AS revenue,
        COALESCE(SUM(subtotal), 0) AS subtotal
      FROM sales
      ${dateFilter}
      GROUP BY DATE_TRUNC('${dateTrunc}', completed_at)
      ORDER BY bucket ASC
    `, params);

    const unitSeriesRes = await client.query(`
      SELECT
        DATE_TRUNC('${dateTrunc}', s.completed_at) AS bucket,
        COALESCE(SUM(sli.quantity), 0) AS units_sold
      FROM sale_line_items sli
      JOIN sales s ON sli.sale_id = s.sale_id
      ${dateFilter}
      GROUP BY DATE_TRUNC('${dateTrunc}', s.completed_at)
      ORDER BY bucket ASC
    `, params);

    const catRes = await client.query(`
      SELECT
        COALESCE(p.category, 'Uncategorized') AS category,
        COALESCE(SUM(sli.line_subtotal), 0) AS revenue,
        COALESCE(SUM(sli.quantity), 0) AS units
      FROM sale_line_items sli
      JOIN products p ON sli.product_id = p.product_id
      JOIN sales s ON sli.sale_id = s.sale_id
      ${dateFilter}
      GROUP BY p.category
      ORDER BY revenue DESC
    `, params);

    const topProdRes = await client.query(`
      SELECT
        p.product_id,
        p.name,
        COALESCE(SUM(sli.line_subtotal), 0) AS revenue,
        COALESCE(SUM(sli.quantity), 0) AS units
      FROM sale_line_items sli
      JOIN products p ON sli.product_id = p.product_id
      JOIN sales s ON sli.sale_id = s.sale_id
      ${dateFilter}
      GROUP BY p.product_id, p.name
      ORDER BY revenue DESC
      LIMIT 8
    `, params);

    const activeSessionRes = await client.query(
      `SELECT COUNT(*) AS active_sessions FROM shopping_sessions WHERE status = 'active'`
    );

    const movActionRes = await client.query(`
      SELECT action, COUNT(*) AS count, COALESCE(SUM(ABS(delta)), 0) AS total_units
      FROM stock_movements
      GROUP BY action
      ORDER BY count DESC
    `);

    const stockDistribution = products.map(p => ({
      name: p.name,
      onHand: p.onHand,
      reserved: p.reserved,
      available: p.available
    }));

    const aovSeries = timeSeriesRes.rows.map(r => ({
      bucket: r.bucket,
      aov: parseInt(r.order_count, 10) > 0 ? Number((parseFloat(r.revenue) / parseInt(r.order_count, 10)).toFixed(2)) : 0
    }));

    return res.json({
      success: true,
      isSimulated: false,
      timeSeries: timeSeriesRes.rows.map(r => ({
        bucket: r.bucket,
        orders: parseInt(r.order_count, 10),
        revenue: parseFloat(r.revenue),
        subtotal: parseFloat(r.subtotal)
      })),
      unitSeries: unitSeriesRes.rows.map(r => ({
        bucket: r.bucket,
        units: parseInt(r.units_sold, 10)
      })),
      aovSeries,
      categorySales: catRes.rows.map(r => ({
        category: r.category,
        revenue: parseFloat(r.revenue),
        units: parseInt(r.units, 10)
      })),
      topProducts: topProdRes.rows.map(r => ({
        id: r.product_id,
        name: r.name,
        revenue: parseFloat(r.revenue),
        units: parseInt(r.units, 10)
      })),
      stockDistribution,
      inventoryMovements: movActionRes.rows.map(r => ({
        action: r.action,
        count: parseInt(r.count, 10),
        totalUnits: parseInt(r.total_units, 10)
      })),
      activeSessions: parseInt(activeSessionRes.rows[0]?.active_sessions, 10) || 0
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    return res.status(500).json({ error: 'Failed to retrieve analytics data' });
  } finally {
    client.release();
  }
});

module.exports = router;
