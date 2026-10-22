/**
 * TrackCart Inventory Intelligence, Demand Forecasting & Market Basket Analysis Service
 */

/**
 * Computes Market Basket Association Rules from transaction records
 * @param {Array<{sale_id: string, items: Array<{product_id: string, name: string}>}>} transactions
 * @param {Array<Object>} products
 */
function calculateMarketBasket(transactions, products = []) {
  const prodMap = new Map();
  products.forEach(p => prodMap.set(p.id || p.product_id, p));

  const totalTransactions = transactions.length;
  if (totalTransactions === 0) {
    return {
      totalEligibleTransactions: 0,
      pairs: [],
      combos: [],
      isSimulated: false,
      message: 'No completed multi-item transactions available yet for basket analysis.'
    };
  }

  // Count item frequency
  const itemCounts = new Map();
  // Count pair frequency
  const pairCounts = new Map();

  transactions.forEach(tx => {
    // Unique products in this transaction
    const uniqueItems = Array.from(new Set(tx.items.map(i => i.product_id)));

    uniqueItems.forEach(item => {
      itemCounts.set(item, (itemCounts.get(item) || 0) + 1);
    });

    for (let i = 0; i < uniqueItems.length; i++) {
      for (let j = i + 1; j < uniqueItems.length; j++) {
        const itemA = uniqueItems[i];
        const itemB = uniqueItems[j];
        const pairKey = itemA < itemB ? `${itemA}|${itemB}` : `${itemB}|${itemA}`;
        pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
      }
    }
  });

  const pairs = [];
  pairCounts.forEach((count, key) => {
    const [idA, idB] = key.split('|');
    const countA = itemCounts.get(idA) || 0;
    const countB = itemCounts.get(idB) || 0;

    const supportAB = count / totalTransactions;
    const supportA = countA / totalTransactions;
    const supportB = countB / totalTransactions;

    const confidenceAtoB = countA > 0 ? (count / countA) : 0;
    const confidenceBtoA = countB > 0 ? (count / countB) : 0;
    const lift = (supportA * supportB > 0) ? (supportAB / (supportA * supportB)) : 0;

    const prodA = prodMap.get(idA) || { name: idA, category: 'General' };
    const prodB = prodMap.get(idB) || { name: idB, category: 'General' };

    let suggestedAction = 'Monitor co-occurrence';
    if (lift >= 1.5 && count >= 2) {
      suggestedAction = 'Recommended for bundle discount or cart checkout prompt';
    } else if (lift >= 1.2) {
      suggestedAction = 'Cross-merchandise on adjacent shelves or display';
    }

    pairs.push({
      productA: { id: idA, name: prodA.name, category: prodA.category },
      productB: { id: idB, name: prodB.name, category: prodB.category },
      coOccurrenceCount: count,
      support: Number(supportAB.toFixed(4)),
      confidenceAtoB: Number(confidenceAtoB.toFixed(4)),
      confidenceBtoA: Number(confidenceBtoA.toFixed(4)),
      lift: Number(lift.toFixed(2)),
      suggestedAction
    });
  });

  // Sort by Lift descending, then transaction count descending
  pairs.sort((a, b) => b.lift - a.lift || b.coOccurrenceCount - a.coOccurrenceCount);

  const combos = pairs.slice(0, 8).map(p => ({
    title: `${p.productA.name} + ${p.productB.name}`,
    productA: p.productA,
    productB: p.productB,
    transactions: p.coOccurrenceCount,
    lift: p.lift,
    confidence: `${(Math.max(p.confidenceAtoB, p.confidenceBtoA) * 100).toFixed(0)}%`,
    recommendation: p.suggestedAction
  }));

  return {
    totalEligibleTransactions: totalTransactions,
    pairs,
    combos,
    isSimulated: false
  };
}

/**
 * Returns realistic simulated market basket analysis for demonstration mode
 */
function getSimulatedMarketBasket(products = []) {
  const prodMap = new Map();
  products.forEach(p => prodMap.set(p.id || p.product_id, p));

  const getName = (id, fallback) => (prodMap.get(id) ? prodMap.get(id).name : fallback);

  const simulatedPairs = [
    {
      productA: { id: 'PROD-004', name: getName('PROD-004', 'Wireless Earbuds'), category: 'Electronics' },
      productB: { id: 'PROD-009', name: getName('PROD-009', 'Bluetooth Tracker Tag'), category: 'Electronics' },
      coOccurrenceCount: 42,
      support: 0.35,
      confidenceAtoB: 0.68,
      confidenceBtoA: 0.72,
      lift: 2.85,
      suggestedAction: 'Create 10% Smart Tech Bundle Offer'
    },
    {
      productA: { id: 'PROD-005', name: getName('PROD-005', 'Cold Brew Coffee 330ml'), category: 'Beverages' },
      productB: { id: 'PROD-010', name: getName('PROD-010', 'Protein Whey Crisp Bar'), category: 'Snacks' },
      coOccurrenceCount: 38,
      support: 0.31,
      confidenceAtoB: 0.62,
      confidenceBtoA: 0.66,
      lift: 2.44,
      suggestedAction: 'Morning Energy Combo (Coffee + Protein Bar)'
    },
    {
      productA: { id: 'PROD002', name: getName('PROD002', 'Organic Granola Bar'), category: 'Snacks' },
      productB: { id: 'PROD-008', name: getName('PROD-008', 'Electrolyte Energy Drink'), category: 'Beverages' },
      coOccurrenceCount: 31,
      support: 0.25,
      confidenceAtoB: 0.54,
      confidenceBtoA: 0.58,
      lift: 2.12,
      suggestedAction: 'Healthy Workout Snack Bundle'
    },
    {
      productA: { id: 'PROD-007', name: getName('PROD-007', 'Smart Phone Grip Ring'), category: 'Accessories' },
      productB: { id: 'PROD-011', name: getName('PROD-011', 'Microfiber Cleaning Cloth'), category: 'Accessories' },
      coOccurrenceCount: 24,
      support: 0.20,
      confidenceAtoB: 0.48,
      confidenceBtoA: 0.52,
      lift: 1.95,
      suggestedAction: 'Mobile Care Add-on at Checkout'
    },
    {
      productA: { id: 'PROD001', name: getName('PROD001', 'Smart Water Bottle'), category: 'Accessories' },
      productB: { id: 'PROD-006', name: getName('PROD-006', 'Organic Trail Mix 200g'), category: 'Snacks' },
      coOccurrenceCount: 20,
      support: 0.16,
      confidenceAtoB: 0.44,
      confidenceBtoA: 0.46,
      lift: 1.78,
      suggestedAction: 'Outdoor & Commuter Pair Recommendation'
    }
  ];

  const combos = simulatedPairs.map(p => ({
    title: `${p.productA.name} + ${p.productB.name}`,
    productA: p.productA,
    productB: p.productB,
    transactions: p.coOccurrenceCount,
    lift: p.lift,
    confidence: `${(p.confidenceAtoB * 100).toFixed(0)}%`,
    recommendation: p.suggestedAction
  }));

  return {
    totalEligibleTransactions: 120,
    pairs: simulatedPairs,
    combos,
    isSimulated: true,
    note: 'Simulated demonstration dataset based on 120 consumer checkout baskets'
  };
}

/**
 * Calculates demand forecasting, days to stockout, and reorder recommendations
 */
function calculateDemandForecast(products = [], daysWindow = 30) {
  const windowDays = Math.max(1, daysWindow);

  return products.map(p => {
    const onHand = parseInt(p.onHand || p.inventory_qty, 10) || 0;
    const reserved = parseInt(p.reserved || p.reserved_qty, 10) || 0;
    const available = Math.max(0, onHand - reserved);
    const soldUnits = parseInt(p.soldUnits || p.sold_units, 10) || 0;

    // Daily demand velocity
    const avgDailySales = Number((soldUnits / windowDays).toFixed(2));

    // Days until stockout
    let daysUntilStockout;
    let stockoutDate;
    if (available === 0) {
      daysUntilStockout = 0;
      stockoutDate = new Date().toISOString().split('T')[0];
    } else if (avgDailySales > 0) {
      daysUntilStockout = Number((available / avgDailySales).toFixed(1));
      const targetDate = new Date(Date.now() + Math.min(daysUntilStockout, 365) * 86400000);
      stockoutDate = targetDate.toISOString().split('T')[0];
    } else {
      daysUntilStockout = 999;
      stockoutDate = 'N/A (> 1 Year)';
    }

    const reorderLevel = parseInt(p.reorderLevel || p.reorder_level, 10) || 10;
    const safetyStock = parseInt(p.safetyStock || p.safety_stock, 10) || 5;
    const leadTimeDays = parseInt(p.leadTimeDays || p.lead_time_days, 10) || 3;
    const targetCoverageDays = parseInt(p.targetCoverageDays || p.target_coverage_days, 10) || 14;

    // Target stock = (Daily Demand * (Lead Time + Target Coverage Days)) + Safety Stock
    const leadTimeDemand = avgDailySales * leadTimeDays;
    const coverageDemand = avgDailySales * targetCoverageDays;
    const targetStock = Math.ceil(leadTimeDemand + coverageDemand + safetyStock);
    const suggestedReorderQty = Math.max(0, targetStock - available);

    // Classification
    let classification = 'Balanced Demand';
    let recommendationReason = 'Inventory level matches current sales velocity.';
    let priority = 'normal';

    if (available === 0) {
      classification = 'Out of Stock';
      recommendationReason = 'Critical stockout! Physical shelf empty.';
      priority = 'urgent';
    } else if (daysUntilStockout <= leadTimeDays) {
      classification = 'Critical Stockout Risk';
      recommendationReason = `Stockout expected in ${daysUntilStockout} days — less than supplier lead time (${leadTimeDays} days).`;
      priority = 'high';
    } else if (available <= reorderLevel) {
      classification = 'Low Stock';
      recommendationReason = `Available stock (${available}) is below reorder threshold (${reorderLevel}).`;
      priority = 'medium';
    } else if (avgDailySales >= 2.0) {
      classification = 'Fast Moving';
      recommendationReason = 'High velocity seller with robust demand.';
      priority = 'normal';
    } else if (avgDailySales === 0 && available > 0) {
      classification = 'Dormant Stock';
      recommendationReason = `No sales recorded in the last ${windowDays} days. Consider price review or bundle.`;
      priority = 'low';
    } else if (daysUntilStockout > 60) {
      classification = 'Slow Moving';
      recommendationReason = `Overstocked: ${daysUntilStockout} days of inventory remaining at current velocity.`;
      priority = 'low';
    }

    return {
      id: p.id || p.product_id,
      name: p.name,
      category: p.category,
      price: parseFloat(p.price) || 0,
      cost: parseFloat(p.cost) || 0,
      onHand,
      reserved,
      available,
      soldUnits,
      windowDays,
      avgDailySales,
      daysUntilStockout,
      stockoutDate,
      reorderLevel,
      safetyStock,
      leadTimeDays,
      targetCoverageDays,
      targetStock,
      suggestedReorderQty,
      classification,
      recommendationReason,
      priority,
      supplier: p.supplier || 'Standard Supplier'
    };
  });
}

/**
 * Returns realistic simulated demand forecast data for demo mode
 */
function getSimulatedDemandForecast(products = []) {
  const simulatedSales = {
    'PROD-004': 78, // Wireless Earbuds
    'PROD001': 45,  // Smart Water Bottle
    'PROD002': 92,  // Granola Bar
    'PROD-005': 84, // Cold Brew
    'PROD-006': 53, // Trail Mix
    'PROD-007': 36, // Phone Grip
    'PROD-008': 110,// Energy Drink
    'PROD-009': 32, // Bluetooth Tracker
    'PROD-010': 64, // Protein Bar
    'PROD-011': 14  // Cleaning Cloth
  };

  const enhancedProducts = products.map(p => ({
    ...p,
    soldUnits: simulatedSales[p.id || p.product_id] || 25
  }));

  const forecast = calculateDemandForecast(enhancedProducts, 30);
  return {
    forecast,
    isSimulated: true,
    note: 'Simulated 30-day velocity forecast for project demonstration'
  };
}

/**
 * Calculates expiry tracking intelligence and promotional discount suggestions
 */
function calculateExpiryIntelligence(products = [], batches = []) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const items = [];

  // 1. Process batches if available
  batches.forEach(b => {
    if (!b.expiry_date) return;
    const expiryDate = new Date(b.expiry_date);
    const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

    let status = 'healthy';
    let action = 'Optimal shelf-life';
    let suggestedDiscount = 0;

    if (diffDays < 0) {
      status = 'expired';
      action = 'Expired — Remove from sale immediately and write off';
      suggestedDiscount = 0;
    } else if (diffDays <= 7) {
      status = 'expiring_7d';
      action = 'Urgent: Expiring within 7 days — 25% Clearance Discount';
      suggestedDiscount = 25;
    } else if (diffDays <= 30) {
      status = 'expiring_30d';
      action = 'Warning: Expiring within 30 days — 10-15% Promotional Discount';
      suggestedDiscount = 15;
    }

    items.push({
      productId: b.product_id,
      name: b.product_name || b.product_id,
      batchNumber: b.batch_number || 'LOT-GENERAL',
      expiryDate: b.expiry_date,
      daysUntilExpiry: diffDays,
      quantityAtRisk: parseInt(b.quantity, 10) || 0,
      status,
      action,
      suggestedDiscount,
      supplier: b.supplier || 'Standard Vendor'
    });
  });

  // 2. Process products with expiry dates if not already represented in batches
  products.forEach(p => {
    if (!p.expiry_date) return;
    if (items.some(item => item.productId === (p.id || p.product_id))) return;

    const expiryDate = new Date(p.expiry_date);
    const diffDays = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));

    let status = 'healthy';
    let action = 'Optimal shelf-life';
    let suggestedDiscount = 0;

    if (diffDays < 0) {
      status = 'expired';
      action = 'Expired — Remove from sale immediately';
    } else if (diffDays <= 7) {
      status = 'expiring_7d';
      action = 'Urgent: Expiring within 7 days — 25% Promo Discount';
      suggestedDiscount = 25;
    } else if (diffDays <= 30) {
      status = 'expiring_30d';
      action = 'Expiring within 30 days — 15% Promo Discount';
      suggestedDiscount = 15;
    }

    items.push({
      productId: p.id || p.product_id,
      name: p.name,
      batchNumber: p.batch_number || 'LOT-DIRECT',
      expiryDate: p.expiry_date,
      daysUntilExpiry: diffDays,
      quantityAtRisk: p.available || p.onHand || 0,
      status,
      action,
      suggestedDiscount,
      supplier: p.supplier || 'General Supplier'
    });
  });

  // Sort by daysUntilExpiry ascending
  items.sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return {
    items,
    isSimulated: false
  };
}

/**
 * Returns realistic simulated expiry tracking data for demo mode
 */
function getSimulatedExpiryData(products = []) {
  const prodMap = new Map();
  products.forEach(p => prodMap.set(p.id || p.product_id, p));

  const getName = (id, fallback) => (prodMap.get(id) ? prodMap.get(id).name : fallback);

  const now = new Date();
  const formatOffset = (days) => {
    const d = new Date(now.getTime() + days * 86400000);
    return d.toISOString().split('T')[0];
  };

  const simulatedItems = [
    {
      productId: 'PROD-005',
      name: getName('PROD-005', 'Cold Brew Coffee 330ml'),
      batchNumber: 'LOT-CB-2026-44',
      expiryDate: formatOffset(5),
      daysUntilExpiry: 5,
      quantityAtRisk: 14,
      status: 'expiring_7d',
      action: 'Expiring in 5 days — 25% Clearance Discount Recommended',
      suggestedDiscount: 25,
      supplier: 'Artisan Roasters'
    },
    {
      productId: 'PROD002',
      name: getName('PROD002', 'Organic Granola Bar'),
      batchNumber: 'LOT-GB-8812',
      expiryDate: formatOffset(12),
      daysUntilExpiry: 12,
      quantityAtRisk: 22,
      status: 'expiring_30d',
      action: 'Expiring in 12 days — 15% Promotional Discount Recommended',
      suggestedDiscount: 15,
      supplier: 'NatureBites LLC'
    },
    {
      productId: 'PROD-010',
      name: getName('PROD-010', 'Protein Whey Crisp Bar'),
      batchNumber: 'LOT-PW-9102',
      expiryDate: formatOffset(21),
      daysUntilExpiry: 21,
      quantityAtRisk: 18,
      status: 'expiring_30d',
      action: 'Expiring in 21 days — 10% Promotional Discount Recommended',
      suggestedDiscount: 10,
      supplier: 'FitFuel Pro'
    },
    {
      productId: 'PROD-008',
      name: getName('PROD-008', 'Electrolyte Energy Drink'),
      batchNumber: 'LOT-ED-3329',
      expiryDate: formatOffset(45),
      daysUntilExpiry: 45,
      quantityAtRisk: 30,
      status: 'healthy',
      action: 'Optimal shelf-life (45 days remaining)',
      suggestedDiscount: 0,
      supplier: 'Volt Beverages'
    },
    {
      productId: 'PROD-006',
      name: getName('PROD-006', 'Organic Trail Mix 200g'),
      batchNumber: 'LOT-TM-5521',
      expiryDate: formatOffset(85),
      daysUntilExpiry: 85,
      quantityAtRisk: 25,
      status: 'healthy',
      action: 'Optimal shelf-life (85 days remaining)',
      suggestedDiscount: 0,
      supplier: 'NatureBites LLC'
    }
  ];

  return {
    items: simulatedItems,
    isSimulated: true,
    note: 'Simulated expiry batch lots for demonstration'
  };
}

module.exports = {
  calculateMarketBasket,
  getSimulatedMarketBasket,
  calculateDemandForecast,
  getSimulatedDemandForecast,
  calculateExpiryIntelligence,
  getSimulatedExpiryData
};
