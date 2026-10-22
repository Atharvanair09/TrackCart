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
    end: jest.fn(),
  };
  return { 
    Pool: jest.fn(() => mPool),
    _mockClient: mClient 
  };
});

const { Pool, _mockClient } = require('pg');
const mockClient = _mockClient;

describe('POST /api/rfid/events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup default successful mock responses
    mockClient.query.mockImplementation((queryText, params) => {
      if (queryText.includes('BEGIN') || queryText.includes('COMMIT') || queryText.includes('ROLLBACK')) {
        return Promise.resolve();
      }
      if (queryText.includes('rfid_events_log') && queryText.includes('SELECT')) {
        return Promise.resolve({ rows: [] }); // No recent duplicate
      }
      if (queryText.includes('rfid_events_log') && queryText.includes('INSERT')) {
        return Promise.resolve();
      }
      if (queryText.includes('FROM carts')) {
        return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      }
      if (queryText.includes('FROM shopping_sessions')) {
        return Promise.resolve({ rows: [{ session_id: 'SESS_1001' }] });
      }
      if (queryText.includes('FROM products')) {
        return Promise.resolve({
          rows: [{
            product_id: 'PROD001',
            tag_uid: '12500123456',
            name: 'Smart Water Bottle',
            price: 19.99,
            category: 'Accessories',
            image_url: 'https://example.com/bottle.jpg',
            is_active: true,
            inventory_qty: 50,
            reserved_qty: 0
          }]
        });
      }
      // Inventory reservation queries
      if (queryText.includes('INSERT INTO inventory_operations')) {
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      if (queryText.includes('SELECT inventory_qty, reserved_qty FROM products')) {
        return Promise.resolve({ rows: [{ inventory_qty: 50, reserved_qty: 0 }] });
      }
      if (queryText.includes('UPDATE products SET reserved_qty')) {
        return Promise.resolve();
      }
      if (queryText.includes('INSERT INTO inventory_movements')) {
        return Promise.resolve();
      }
      if (queryText.includes('UPDATE inventory_operations SET status')) {
        return Promise.resolve();
      }
      if (queryText.includes('cart_items ci')) { // The join query for cart items
        return Promise.resolve({
          rows: [{
            session_id: 'SESS_1001',
            product_id: 'PROD001',
            quantity: 1,
            unit_price_at_addition: 19.99,
            subtotal: 19.99,
            name: 'Smart Water Bottle'
          }]
        });
      }
      if (queryText.includes('FROM cart_items')) { // Checking if item exists
        return Promise.resolve({ rows: [] });
      }
      if (queryText.includes('INSERT INTO cart_items') || queryText.includes('UPDATE cart_items')) {
        return Promise.resolve();
      }
      return Promise.resolve({ rows: [] });
    });
  });

  test('should return 400 for missing deviceId', async () => {
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ tagUid: '12345' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/deviceId/);
  });

  test('should return 400 for missing tagUid', async () => {
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/tagUid/);
  });

  test('should return 429 for duplicate RFID event', async () => {
    mockClient.query.mockImplementationOnce(() => Promise.resolve()) // BEGIN
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: 1 }] })); // Duplicate found
      
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '123456' });

    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('Duplicate RFID event detected');
  });

  test('should return 400 if device is not mapped to cart', async () => {
    mockClient.query.mockImplementation((queryText, params) => {
      if (queryText.includes('BEGIN')) return Promise.resolve();
      if (queryText.includes('rfid_events_log')) return Promise.resolve({ rows: [] });
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [] }); // No cart
      return Promise.resolve({ rows: [] });
    });
      
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '123456' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Device is not associated with any cart');
  });

  test('should return 403 if no active session', async () => {
    mockClient.query.mockImplementation((queryText, params) => {
      if (queryText.includes('BEGIN')) return Promise.resolve();
      if (queryText.includes('rfid_events_log')) return Promise.resolve({ rows: [] });
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      if (queryText.includes('FROM shopping_sessions')) return Promise.resolve({ rows: [] }); // No session
      return Promise.resolve({ rows: [] });
    });
      
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '123456' });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('No active shopping session for this cart');
  });

  test('should return 404 for unknown RFID tag', async () => {
    mockClient.query.mockImplementation((queryText, params) => {
      if (queryText.includes('BEGIN')) return Promise.resolve();
      if (queryText.includes('rfid_events_log')) return Promise.resolve({ rows: [] });
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      if (queryText.includes('FROM shopping_sessions')) return Promise.resolve({ rows: [{ session_id: 'SESS_1001' }] });
      if (queryText.includes('FROM products')) return Promise.resolve({ rows: [] }); // Unknown product
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: 'DEADBEEF999' });

    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Unregistered RFID tag');
  });

  test('should return 200 and updated cart for successful new addition', async () => {
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '12500123456' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.sessionId).toBe('SESS_1001');
    expect(res.body.cart.cartId).toBe('CART_01');
    expect(res.body.message).toBe('Product added to cart');
    expect(res.body.product.productId).toBe('PROD001');
    expect(res.body.cartTotal).toBe(19.99);
    expect(res.body.items).toHaveLength(1);
  });

  test('should resolve cart by firmware device_id (cart-001 -> CART_01)', async () => {
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'cart-001', tagUid: '12500123456' });

    expect(res.statusCode).toBe(200);
    expect(res.body.cart.cartId).toBe('CART_01');
    expect(res.body.session.sessionId).toBe('SESS_1001');

    const cartLookup = mockClient.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM carts')
    );
    expect(cartLookup).toBeDefined();
    expect(cartLookup[0]).toMatch(/LOWER\(device_id\)/i);
    expect(cartLookup[0]).toMatch(/LOWER\(cart_id\)/i);
    expect(cartLookup[1]).toEqual(['cart-001']);
  });

  test('should resolve cart by PWA cart_id when firmware sends CART_01', async () => {
    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'CART_01', tagUid: '12:50:01:23:45:6' });

    expect(res.statusCode).toBe(200);
    expect(res.body.cart.cartId).toBe('CART_01');
    expect(res.body.product.productId).toBe('PROD001');
  });

  test('should return 200 and increment quantity for duplicate product', async () => {
    // Setup mock to simulate item already in cart
    // Setup mock for duplicate product scenario with inventory reservation
    mockClient.query.mockImplementation((queryText, params) => {
      // Transaction control
      if (queryText.includes('BEGIN') || queryText.includes('COMMIT')) return Promise.resolve();
      // Deduplication check
      if (queryText.includes('rfid_events_log') && queryText.includes('SELECT')) return Promise.resolve({ rows: [] });
      if (queryText.includes('rfid_events_log') && queryText.includes('INSERT')) return Promise.resolve();
      // Cart lookup
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      // Session lookup
      if (queryText.includes('FROM shopping_sessions')) return Promise.resolve({ rows: [{ session_id: 'SESS_1001' }] });
      // Product lookup (include inventory fields)
      if (queryText.includes('FROM products')) {
        return Promise.resolve({
          rows: [{
            product_id: 'PROD001',
            tag_uid: '12500123456',
            name: 'Smart Water Bottle',
            price: 19.99,
            is_active: true,
            inventory_qty: 50,
            reserved_qty: 0
          }]
        });
      }
      // Existing cart item check
      if (queryText.includes('FROM cart_items') && queryText.includes('SELECT *')) {
        return Promise.resolve({
          rows: [{
            session_id: 'SESS_1001',
            product_id: 'PROD001',
            quantity: 1,
            unit_price_at_addition: 19.99,
            subtotal: 19.99
          }]
        });
      }
      // Inventory reservation workflow
      if (queryText.includes('INSERT INTO inventory_operations')) {
        return Promise.resolve({ rows: [{ id: '1' }] });
      }
      if (queryText.includes('SELECT inventory_qty, reserved_qty FROM products')) {
        return Promise.resolve({ rows: [{ inventory_qty: 50, reserved_qty: 0 }] });
      }
      if (queryText.includes('UPDATE products SET reserved_qty')) {
        return Promise.resolve();
      }
      if (queryText.includes('INSERT INTO inventory_movements')) {
        return Promise.resolve();
      }
      if (queryText.includes('UPDATE inventory_operations SET status')) {
        return Promise.resolve();
      }
      // Update existing cart item
      if (queryText.includes('UPDATE cart_items')) return Promise.resolve();
      // Return updated cart items list
      if (queryText.includes('cart_items ci')) {
        return Promise.resolve({
          rows: [{
            session_id: 'SESS_1001',
            product_id: 'PROD001',
            quantity: 2,
            unit_price_at_addition: 19.99,
            subtotal: 39.98,
            name: 'Smart Water Bottle'
          }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '12500123456' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('Product added to cart');
    expect(res.body.items[0].quantity).toBe(2);
    expect(res.body.cartTotal).toBe(39.98);
  });

  test('should return 400 for inactive product', async () => {
    mockClient.query.mockImplementation((queryText, params) => {
      if (queryText.includes('BEGIN')) return Promise.resolve();
      if (queryText.includes('rfid_events_log') && queryText.includes('SELECT')) return Promise.resolve({ rows: [] });
      if (queryText.includes('rfid_events_log') && queryText.includes('INSERT')) return Promise.resolve();
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      if (queryText.includes('FROM shopping_sessions')) return Promise.resolve({ rows: [{ session_id: 'SESS_1001' }] });
      if (queryText.includes('FROM products')) {
        return Promise.resolve({
          rows: [{
            product_id: 'PROD002',
            tag_uid: '12500123457',
            name: 'Inactive Item',
            price: 9.99,
            is_active: false // Inactive!
          }]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '12500123457' });

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Product is inactive');
  });

  test('should handle multiple different products correctly', async () => {
    // This mostly verifies the cart total calculation with multiple items
    // Mock for multiple different products scenario with inventory reservation
    mockClient.query.mockImplementation((queryText, params) => {
      // Transaction control
      if (queryText.includes('BEGIN') || queryText.includes('COMMIT')) return Promise.resolve();
      // Deduplication
      if (queryText.includes('rfid_events_log') && queryText.includes('SELECT')) return Promise.resolve({ rows: [] });
      if (queryText.includes('rfid_events_log') && queryText.includes('INSERT')) return Promise.resolve();
      // Cart lookup
      if (queryText.includes('FROM carts')) return Promise.resolve({ rows: [{ cart_id: 'CART_01' }] });
      // Session lookup
      if (queryText.includes('FROM shopping_sessions')) return Promise.resolve({ rows: [{ session_id: 'SESS_1001' }] });
      // Product lookup (include inventory fields)
      if (queryText.includes('FROM products')) {
        return Promise.resolve({
          rows: [{
            product_id: 'PROD003',
            tag_uid: '12500123458',
            name: 'Second Item',
            price: 5.00,
            is_active: true,
            inventory_qty: 30,
            reserved_qty: 0
          }]
        });
      }
      // No existing cart item for this new product
      if (queryText.includes('FROM cart_items') && queryText.includes('SELECT *')) return Promise.resolve({ rows: [] });
      // Insert new cart item
      if (queryText.includes('INSERT INTO cart_items')) return Promise.resolve();
      // Inventory reservation workflow
      if (queryText.includes('INSERT INTO inventory_operations')) return Promise.resolve({ rows: [{ id: '2' }] });
      if (queryText.includes('SELECT inventory_qty, reserved_qty FROM products')) return Promise.resolve({ rows: [{ inventory_qty: 30, reserved_qty: 0 }] });
      if (queryText.includes('UPDATE products SET reserved_qty')) return Promise.resolve();
      if (queryText.includes('INSERT INTO inventory_movements')) return Promise.resolve();
      if (queryText.includes('UPDATE inventory_operations SET status')) return Promise.resolve();
      // Return updated cart items list (including existing first item and the new second item)
      if (queryText.includes('cart_items ci')) {
        return Promise.resolve({
          rows: [
            {
              session_id: 'SESS_1001',
              product_id: 'PROD001',
              quantity: 1,
              unit_price_at_addition: 19.99,
              subtotal: 19.99,
              name: 'Smart Water Bottle'
            },
            {
              session_id: 'SESS_1001',
              product_id: 'PROD003',
              quantity: 1,
              unit_price_at_addition: 5.00,
              subtotal: 5.00,
              name: 'Second Item'
            }
          ]
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post('/api/rfid/events')
      .send({ deviceId: 'DEV01', tagUid: '12500123458' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.cartTotal).toBe(24.99); // 19.99 + 5.00
  });
});
