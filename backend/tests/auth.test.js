const request = require('supertest');
const app = require('../index');
const { pool, hashPassword } = require('../db');

describe('Admin Authentication APIs', () => {
  const testEmail = 'ojharamakant48@gmail.com';
  const testPassword = 'Sahil@1234567';

  let sessionToken = null;

  it('rejects login with missing email or password (400)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: '' });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects login with invalid credentials (401)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: 'WrongPassword999!' });

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('logs in successfully with stored admin credentials (200)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testEmail, password: testPassword });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body).toHaveProperty('token');
    expect(res.body.admin.email).toBe(testEmail);

    sessionToken = res.body.token;
  });

  it('verifies active session token (200)', async () => {
    const res = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.admin.email).toBe(testEmail);
  });

  it('rejects verification with invalid token (401)', async () => {
    const res = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', 'Bearer invalid_token_123');

    expect(res.statusCode).toBe(401);
    expect(res.body.valid).toBe(false);
  });

  it('logs out and invalidates the session token (200)', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify token is now invalid
    const verifyRes = await request(app)
      .get('/api/auth/verify')
      .set('Authorization', `Bearer ${sessionToken}`);

    expect(verifyRes.statusCode).toBe(401);
  });
});
