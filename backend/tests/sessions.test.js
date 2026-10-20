const request = require('supertest');
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

const { Pool, _mockClient, _mockPool } = require('pg');
const mockClient = _mockClient;
const mockPool = _mockPool;

describe('Session APIs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
          if (queryText.includes('UPDATE shopping_sessions')) {
            return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'completed' }] });
          }
          if (queryText.includes('SELECT * FROM sales')) {
            return Promise.resolve({ rows: [] }); // No existing sale
          }
          if (queryText.includes('SELECT ci.*, p.price')) {
            // Return one cart item
            return Promise.resolve({ rows: [{ product_id: 'PROD01', unit_price_at_addition: 10, quantity: 2 }] });
          }
          if (queryText.includes('INSERT INTO sales')) {
            return Promise.resolve({ rows: [{ sale_id: 'SALE_123', subtotal: 20, tax_rate: 0.0825, tax_amount: 1.65, total: 21.65 }] });
          }
          if (queryText.includes('INSERT INTO sale_line_items')) {
            return Promise.resolve();
          }
          return Promise.resolve({ rows: [] });
        }),
        release: jest.fn()
      };
      // mock pool.connect to return our mock client
      mockPool.connect.mockResolvedValue(mockClient);

      const res = await request(app).post('/api/sessions/SESS_TEST/checkout');
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
});
