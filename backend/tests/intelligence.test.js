const {
  calculateMarketBasket,
  getSimulatedMarketBasket,
  calculateDemandForecast,
  getSimulatedDemandForecast,
  calculateExpiryIntelligence,
  getSimulatedExpiryData
} = require('../services/analytics');

describe('Inventory Intelligence & Analytics Service Tests', () => {

  describe('Market Basket Association Rules', () => {
    const products = [
      { id: 'P1', name: 'Product 1', category: 'CatA' },
      { id: 'P2', name: 'Product 2', category: 'CatB' },
      { id: 'P3', name: 'Product 3', category: 'CatA' },
      { id: 'P4', name: 'Product 4', category: 'CatC' }
    ];

    test('calculates correct Support, Confidence, and Lift for transactions', () => {
      // 4 transactions:
      // T1: P1, P2
      // T2: P1, P2
      // T3: P1, P3
      // T4: P2, P4
      const transactions = [
        { sale_id: 'S1', items: [{ product_id: 'P1' }, { product_id: 'P2' }] },
        { sale_id: 'S2', items: [{ product_id: 'P1' }, { product_id: 'P2' }] },
        { sale_id: 'S3', items: [{ product_id: 'P1' }, { product_id: 'P3' }] },
        { sale_id: 'S4', items: [{ product_id: 'P2' }, { product_id: 'P4' }] }
      ];

      const result = calculateMarketBasket(transactions, products);
      expect(result.totalEligibleTransactions).toBe(4);
      expect(result.isSimulated).toBe(false);

      const p1p2 = result.pairs.find(p =>
        (p.productA.id === 'P1' && p.productB.id === 'P2') ||
        (p.productA.id === 'P2' && p.productB.id === 'P1')
      );

      expect(p1p2).toBeDefined();
      expect(p1p2.coOccurrenceCount).toBe(2);
      // Support(P1, P2) = 2 / 4 = 0.5
      expect(p1p2.support).toBe(0.5);
      // Confidence(P1 -> P2) = 2 / 3 = 0.6667
      expect(p1p2.confidenceAtoB).toBeCloseTo(0.67, 1);
      // Support(P1) = 3/4 = 0.75, Support(P2) = 3/4 = 0.75
      // Lift = 0.5 / (0.75 * 0.75) = 0.5 / 0.5625 = 0.8889
      expect(p1p2.lift).toBeCloseTo(0.89, 1);
    });

    test('handles empty transactions gracefully', () => {
      const result = calculateMarketBasket([], products);
      expect(result.totalEligibleTransactions).toBe(0);
      expect(result.pairs).toEqual([]);
      expect(result.combos).toEqual([]);
    });

    test('simulated market basket returns isolated demo data', () => {
      const demoResult = getSimulatedMarketBasket(products);
      expect(demoResult.isSimulated).toBe(true);
      expect(demoResult.totalEligibleTransactions).toBeGreaterThan(0);
      expect(demoResult.pairs.length).toBeGreaterThan(0);
      expect(demoResult.combos.length).toBeGreaterThan(0);
    });
  });

  describe('Demand Forecasting & Reorder Recommendations', () => {
    test('calculates correct daily velocity, days to stockout, and reorder quantities', () => {
      const testProducts = [
        {
          id: 'PROD_TEST_1',
          name: 'Wireless Earbuds',
          category: 'Electronics',
          price: 40.0,
          inventory_qty: 12,
          reserved_qty: 2,
          reorder_level: 15,
          safety_stock: 5,
          lead_time_days: 3,
          target_coverage_days: 14,
          soldUnits: 90 // 90 units in 30 days = 3.0 units/day
        }
      ];

      const forecast = calculateDemandForecast(testProducts, 30);
      expect(forecast).toHaveLength(1);

      const f = forecast[0];
      // Available = 12 - 2 = 10
      expect(f.available).toBe(10);
      // Avg Daily Sales = 90 / 30 = 3.0
      expect(f.avgDailySales).toBe(3.0);
      // Days to stockout = 10 / 3.0 = 3.3 days
      expect(f.daysUntilStockout).toBe(3.3);
      // Lead time = 3 days, so daysUntilStockout (3.3) <= leadTimeDays + buffer
      expect(f.classification).toBe('Low Stock');
      // Target Stock = (Daily Demand * (Lead Time + Target Coverage Days)) + Safety Stock
      // = (3.0 * (3 + 14)) + 5 = (3.0 * 17) + 5 = 51 + 5 = 56
      expect(f.targetStock).toBe(56);
      // Suggested Reorder = Max(0, 56 - 10) = 46
      expect(f.suggestedReorderQty).toBe(46);
    });

    test('handles zero sales gracefully without division by zero', () => {
      const zeroSalesProducts = [
        {
          id: 'PROD_ZERO',
          name: 'Slow Mover',
          inventory_qty: 20,
          reserved_qty: 0,
          soldUnits: 0
        }
      ];

      const forecast = calculateDemandForecast(zeroSalesProducts, 30);
      expect(forecast[0].avgDailySales).toBe(0);
      expect(forecast[0].daysUntilStockout).toBe(999);
      expect(forecast[0].classification).toBe('Dormant Stock');
    });

    test('handles out-of-stock items correctly', () => {
      const outOfStockProducts = [
        {
          id: 'PROD_EMPTY',
          name: 'Empty Item',
          inventory_qty: 0,
          reserved_qty: 0,
          soldUnits: 30
        }
      ];

      const forecast = calculateDemandForecast(outOfStockProducts, 30);
      expect(forecast[0].available).toBe(0);
      expect(forecast[0].daysUntilStockout).toBe(0);
      expect(forecast[0].classification).toBe('Out of Stock');
      expect(forecast[0].priority).toBe('urgent');
    });
  });

  describe('Expiry Tracking & Smart Offers', () => {
    test('correctly classifies batches into expiry alert windows', () => {
      const now = new Date();
      const formatDate = (daysOffset) => {
        const d = new Date(now.getTime() + daysOffset * 86400000);
        return d.toISOString().split('T')[0];
      };

      const testBatches = [
        { product_id: 'P_EXP', batch_number: 'B1', quantity: 10, expiry_date: formatDate(-2) }, // Expired
        { product_id: 'P_7D', batch_number: 'B2', quantity: 15, expiry_date: formatDate(4) },   // Expiring in 4 days
        { product_id: 'P_30D', batch_number: 'B3', quantity: 20, expiry_date: formatDate(18) }, // Expiring in 18 days
        { product_id: 'P_HLT', batch_number: 'B4', quantity: 50, expiry_date: formatDate(60) }  // Healthy
      ];

      const result = calculateExpiryIntelligence([], testBatches);
      expect(result.items).toHaveLength(4);

      const expired = result.items.find(i => i.productId === 'P_EXP');
      expect(expired.status).toBe('expired');
      expect(expired.suggestedDiscount).toBe(0); // Expired should not be discounted for sale

      const exp7d = result.items.find(i => i.productId === 'P_7D');
      expect(exp7d.status).toBe('expiring_7d');
      expect(exp7d.suggestedDiscount).toBe(25); // 25% discount recommendation

      const exp30d = result.items.find(i => i.productId === 'P_30D');
      expect(exp30d.status).toBe('expiring_30d');
      expect(exp30d.suggestedDiscount).toBe(15); // 15% discount recommendation

      const healthy = result.items.find(i => i.productId === 'P_HLT');
      expect(healthy.status).toBe('healthy');
      expect(healthy.suggestedDiscount).toBe(0);
    });

    test('simulated expiry returns isolated demo batches', () => {
      const demoExpiry = getSimulatedExpiryData();
      expect(demoExpiry.isSimulated).toBe(true);
      expect(demoExpiry.items.length).toBeGreaterThan(0);
    });
  });
});
