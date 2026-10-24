const request = require('supertest');
jest.mock('../services/paymentService', () => ({
  isConfigured: jest.fn(() => true),
  verifySignature: jest.fn(() => true),
  createOrder: jest.fn()
}));

const app = require('../index');

// Mock the 'pg' module
jest.mock('pg', () => {
  const mClient = {
    query: jest.fn(),
    release: jest.fn()
  };
  const mPool = {
    connect: jest.fn(() => Promise.resolve(mClient)),
    query: jest.fn(),
    end: jest.fn(),
  };
  return { 
    Pool: jest.fn(() => mPool),
    _mockClient: mClient,
    _mockPool: mPool
  };
});

// Mock Razorpay payment service
jest.mock('../services/paymentService', () => ({
  isConfigured: jest.fn(() => true),
  verifySignature: jest.fn(() => true),
  createOrder: jest.fn()
}));

const { Pool, _mockClient, _mockPool } = require('pg');
const mockClient = _mockClient;
const mockPool = _mockPool;

describe('Session APIs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    mockPool.connect.mockResolvedValue(mockClient);
  });

  describe('POST /api/sessions', () => {
    beforeEach(() => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('FROM users')) {
          return Promise.resolve({ rows: [{ user_id: 'USER123' }] });
        }
        if (queryText.includes('FROM carts')) {
          return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
        }
        if (queryText.includes('FROM shopping_sessions') && queryText.includes('SELECT')) {
          return Promise.resolve({ rows: [] }); // No active session
        }
        if (queryText.includes('INSERT INTO shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', user_id: 'USER123', cart_id: 'CART_01', status: 'active' }] });
        }
        return Promise.resolve({ rows: [] });
      });
    });

    test('should start a session successfully (TEST 1)', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ userId: 'USER123', cartId: 'CART_01' });

      expect(res.statusCode).toBe(201);
      expect(res.body.session_id).toBe('SESS_TEST');
      expect(res.body.status).toBe('active');
    });

    test('new session should have last_activity_at set (TEST 1.2)', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ userId: 'USER123', cartId: 'CART_01' });
      expect(res.statusCode).toBe(201);
      expect(res.body.last_activity_at).toBeDefined();
      expect(res.body.last_activity_at).not.toBeNull();
    });

    test('should start a session successfully without userId (TEST 1.1)', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ cartId: 'CART_01' });

      expect(res.statusCode).toBe(201);
      expect(res.body.session_id).toBe('SESS_TEST');
      expect(res.body.status).toBe('active');
    });

    test('should reject if cart is already in use by active session (TEST 2)', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN')) return Promise.resolve();
        if (queryText.includes('FROM users')) return Promise.resolve({ rows: [{ user_id: 'USER123' }] });
        if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
        if (queryText.includes('FROM shopping_sessions') && queryText.includes('SELECT')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_EXISTING', status: 'active' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app)
        .post('/api/sessions')
        .send({ userId: 'USER123', cartId: 'CART_01' });

      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('Cart is already in use by an active session');
    });
  });

  describe('GET /api/sessions/:sessionId', () => {
    test('should retrieve an existing session', async () => {
      mockPool.query.mockImplementation((queryText, params) => {
        if (queryText.includes('FROM shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD01', subtotal: 10 }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).get('/api/sessions/SESS_TEST');
      expect(res.statusCode).toBe(200);
      expect(res.body.session_id).toBe('SESS_TEST');
      expect(res.body.cartTotal).toBe(10);
    });
  });

  describe('POST /api/sessions/:sessionId/end', () => {
    test('should complete a checkout via /checkout (TEST 9)', async () => {
      // Mock client connection and queries
    const mockClient = {
      query: jest.fn((queryText, params) => {
        if (
          queryText.includes('FROM shopping_sessions') &&
          queryText.includes('FOR UPDATE')
        ) {
          return Promise.resolve({
            rows: [{ session_id: 'SESS_TEST', status: 'active' }]
          });
        }

        if (queryText.includes('SELECT * FROM sales')) {
          return Promise.resolve({ rows: [] }); // No existing sale
        }

        if (queryText.includes('SELECT ci.*, p.price')) {
          // Return one cart item
          return Promise.resolve({
            rows: [{
              product_id: 'PROD01',
              unit_price_at_addition: 10,
              quantity: 2
            }]
          });
        }

        if (queryText.includes('UPDATE products SET inventory_qty')) {
          return Promise.resolve({ rowCount: 1 });
        }

        if (queryText.includes('INSERT INTO sales')) {
          return Promise.resolve({
            rows: [{
              sale_id: 'SALE_123',
              subtotal: 20,
              tax_rate: 0.0825,
              tax_amount: 1.65,
              total: 21.65
            }]
          });
        }

        if (queryText.includes('INSERT INTO sale_line_items')) {
          return Promise.resolve({ rows: [] });
        }

        if (queryText.includes('UPDATE shopping_sessions')) {
          return Promise.resolve({
            rows: [{ session_id: 'SESS_TEST', status: 'completed' }]
          });
        }

        // Mock reservation lookup for product PROD01 (quantity 2)
        if (queryText.includes('FROM inventory_operations') && queryText.includes('reservation')) {
          return Promise.resolve({ rows: [{ operation_id: 1, reserved_quantity: 2 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn()
    };
      // mock pool.connect to return our mock client
      mockPool.connect.mockResolvedValue(mockClient);

      const res = await request(app).post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('sale_id');
    });
  });
  // Decrement endpoint tests
  describe('POST /api/sessions/:sessionId/items/:productId/decrement', () => {
    test('should decrement quantity when >1 (TEST 10)', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT * FROM shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD01', quantity: 2, unit_price_at_addition: 5, subtotal: 10 }] });
        }
        if (queryText.includes('UPDATE cart_items')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT ci.*, p.name')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD01', quantity: 1, unit_price_at_addition: 5, subtotal: 5, name: 'Item', image_url: '' }] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await request(app).post('/api/sessions/SESS_TEST/items/PROD01/decrement');
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cart.total).toBe(5);
      expect(res.body.cart.items[0].quantity).toBe(1);
    });

    test('should remove item when quantity is 1 (TEST 11)', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT * FROM shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD02', quantity: 1, unit_price_at_addition: 7, subtotal: 7 }] });
        }
        if (queryText.includes('DELETE FROM cart_items')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT ci.*, p.name')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await request(app).post('/api/sessions/SESS_TEST/items/PROD02/decrement');
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.cart.total).toBe(0);
      expect(res.body.cart.items.length).toBe(0);
    });

    test('should return 404 for nonexistent session (TEST 12)', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT * FROM shopping_sessions')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await request(app).post('/api/sessions/UNKNOWN/items/PROD01/decrement');
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Active session not found');
    });

    test('should return 404 for missing item (TEST 13)', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('SELECT * FROM shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM cart_items')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });
      const res = await request(app).post('/api/sessions/SESS_TEST/items/NONEXIST/decrement');
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toBe('Item not found in cart');
    });
  });
  // Inventory deduction tests
  describe('Inventory deduction during checkout', () => {
    test('should deduct inventory on successful checkout', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('FROM shopping_sessions') && queryText.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM sales')) {
          return Promise.resolve({ rows: [] });
        }
        if (queryText.includes('FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD01', quantity: 2, unit_price_at_addition: 10 }] });
        }
        // Mock reservation check
        if (queryText.includes('FROM inventory_operations') && queryText.includes('reservation')) {
  return Promise.resolve({ rows: [{ operation_id: 1, reserved_quantity: 2 }] });
}
        // Fallback reservation mock
        if (queryText.includes('reservation')) {
          return Promise.resolve({ rows: [{ operation_id: 1, reserved_quantity: 2 }] });
        }
        // Mock inventory update (deduct both inventory and reserved)
        if (queryText.includes('UPDATE products SET inventory_qty')) {
          return Promise.resolve({ rowCount: 1 });
        }
        // Mock insertion of sale operation
        if (queryText.includes('INSERT INTO inventory_operations') && queryText.includes('sale')) {
          return Promise.resolve({ rows: [{ id: 10 }] });
        }
        // Mock insertion of inventory movement for sale
        if (queryText.includes('INSERT INTO inventory_movements') && queryText.includes('sale')) {
          return Promise.resolve({ rows: [] });
        }
        if (queryText.includes('INSERT INTO sales')) {
          return Promise.resolve({ rows: [{ sale_id: 'SALE_123', subtotal: 20, tax_rate: 0.0825, tax_amount: 1.65, total: 21.65 }] });
        }
        if (queryText.includes('INSERT INTO sale_line_items')) {
          return Promise.resolve();
        }
        if (queryText.includes('UPDATE shopping_sessions SET status')) {
          return Promise.resolve();
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toHaveProperty('sale_id');
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE products SET inventory_qty'),
        [2, 'PROD01']
      );
        // Verify transaction commit and no rollback
        const commitCalls = mockClient.query.mock.calls.filter(call => call[0].includes('COMMIT'));
        expect(commitCalls.length).toBe(1);
        expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));

        // Verify inventory deduction called once per product with correct qty
        const inventoryCalls = mockClient.query.mock.calls.filter(call => call[0].includes('UPDATE products SET inventory_qty'));
        expect(inventoryCalls.length).toBe(1);
        expect(inventoryCalls[0][1]).toEqual([2, 'PROD01']);

        // Verify sale insertion and session status update
        expect(
          mockClient.query.mock.calls.some(call =>
            call[0].includes('INSERT INTO sales')
          )
        ).toBe(true);

        expect(
          mockClient.query.mock.calls.some(call =>
            call[0].includes('UPDATE shopping_sessions SET status')
          )
        ).toBe(true);

        // Verify response shape contains expected fields
        expect(res.body).toMatchObject({
          sale_id: expect.any(String),
          subtotal: expect.any(Number),
          tax_rate: expect.any(Number),
          tax_amount: expect.any(Number),
          total: expect.any(Number)
        });
    });

    test('should return 400 when inventory insufficient', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('FROM shopping_sessions') && queryText.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM sales')) {
          return Promise.resolve({ rows: [] });
        }
        if (queryText.includes('FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD02', quantity: 5, unit_price_at_addition: 10 }] });
        }
        // Mock reservation check for insufficient stock test
        if (queryText.includes('SELECT io.id') && queryText.includes('reservation')) {
          return Promise.resolve({ rows: [{ operation_id: 1, reserved_quantity: 5 }] });
        }
        if (queryText.includes('UPDATE products SET inventory_qty')) {
          return Promise.resolve({ rowCount: 0 });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Insufficient stock/);
      // Verify rollback occurred and no commit
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('COMMIT'));
      // Ensure no sale or session update was attempted
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sales'));
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE shopping_sessions SET status'));
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE products SET inventory_qty'), [5, 'PROD02']);
    });

    test('inventory update throws triggers 500 and rollback', async () => {
      mockClient.query.mockImplementation((queryText, params) => {
        if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
          return Promise.resolve();
        }
        if (queryText.includes('FROM shopping_sessions') && queryText.includes('FOR UPDATE')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'active' }] });
        }
        if (queryText.includes('SELECT * FROM sales')) {
          return Promise.resolve({ rows: [] });
        }
        if (queryText.includes('FROM cart_items')) {
          return Promise.resolve({ rows: [{ product_id: 'PROD99', quantity: 1, unit_price_at_addition: 10 }] });
        }
        // Mock reservation check for DB failure test
        if (queryText.includes('SELECT io.id') && queryText.includes('reservation')) {
          return Promise.resolve({ rows: [{ operation_id: 2, reserved_quantity: 1 }] });
        }
        if (queryText.includes('UPDATE products SET inventory_qty')) {
          return Promise.reject(new Error('DB failure'));
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });
      expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal server error');
      // Verify rollback occurred and no commit
      expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK'));
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('COMMIT'));
      // Ensure no sale or session update was performed
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sales'));
      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE shopping_sessions SET status'));
    });

    test('repeated checkout is idempotent and does not deduct again', async () => {
  const sale = {
    sale_id: 'SALE_1',
    subtotal: 5,
    tax_rate: 0.0825,
    tax_amount: 0.41,
    total: 5.41
  };

  let saleCreated = false;

  mockClient.query.mockImplementation((queryText, params) => {
    if (
      queryText.includes('BEGIN') ||
      queryText.includes('COMMIT') ||
      queryText.includes('ROLLBACK')
    ) {
      return Promise.resolve();
    }

    if (
      queryText.includes('FROM shopping_sessions') &&
      queryText.includes('FOR UPDATE')
    ) {
      return Promise.resolve({
        rows: [{ session_id: 'SESS_TEST', status: 'active' }]
      });
    }

    if (queryText.includes('SELECT * FROM sales')) {
      return Promise.resolve({
        rows: saleCreated ? [sale] : []
      });
    }

    if (queryText.includes('FROM cart_items')) {
      return Promise.resolve({
        rows: [{
          product_id: 'PROD03',
          quantity: 1,
          unit_price_at_addition: 5
        }]
      });
    }

    // Mock reservation check for idempotency test
    if (queryText.includes('SELECT io.id') && queryText.includes('reservation')) {
      return Promise.resolve({ rows: [{ operation_id: 3, reserved_quantity: 1 }] });
    }

    if (queryText.includes('UPDATE products SET inventory_qty')) {
      return Promise.resolve({ rowCount: 1 });
    }

    // Insert sale operation (needs id for movements)
    if (queryText.includes('INSERT INTO inventory_operations') && queryText.includes('sale')) {
      return Promise.resolve({ rows: [{ id: 99 }] });
    }

    // Insert inventory movement for sale
    if (queryText.includes('INSERT INTO inventory_movements') && queryText.includes('sale')) {
      return Promise.resolve({ rows: [] });
    }

    if (queryText.includes('INSERT INTO sales')) {
      saleCreated = true;
      return Promise.resolve({ rows: [sale] });
    }

    if (queryText.includes('INSERT INTO sale_line_items')) {
      return Promise.resolve({ rows: [] });
    }

    if (queryText.includes('UPDATE shopping_sessions SET status')) {
      return Promise.resolve({ rows: [] });
    }

    return Promise.resolve({ rows: [] });
  });

  const first = await request(app)
    .post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });

  expect(first.statusCode).toBe(200);
  expect(first.body.sale_id).toBe('SALE_1');

  const second = await request(app)
    .post('/api/sessions/SESS_TEST/checkout').send({ razorpay_order_id: 'order_123', razorpay_payment_id: 'pay_123', razorpay_signature: 'sig_abc' });

  expect(second.statusCode).toBe(200);
  expect(second.body.sale_id).toBe('SALE_1');

  const saleInsertCalls = mockClient.query.mock.calls.filter(
    call => call[0].includes('INSERT INTO sales')
  );
  expect(saleInsertCalls).toHaveLength(1);

  const lineItemInsertCalls = mockClient.query.mock.calls.filter(
    call => call[0].includes('INSERT INTO sale_line_items')
  );
  expect(lineItemInsertCalls).toHaveLength(1);

  const inventoryCalls = mockClient.query.mock.calls.filter(
    call => call[0].includes('UPDATE products SET inventory_qty')
  );
  expect(inventoryCalls).toHaveLength(1);
});
});
});
