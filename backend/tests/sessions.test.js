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
    test('should complete a session (TEST 9)', async () => {
      mockPool.query.mockImplementation((queryText, params) => {
        if (queryText.includes('UPDATE shopping_sessions')) {
          return Promise.resolve({ rows: [{ session_id: 'SESS_TEST', status: 'completed' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const res = await request(app).post('/api/sessions/SESS_TEST/end');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('completed');
    });
  });
});
