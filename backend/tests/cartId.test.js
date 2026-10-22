const { normalizeCartId } = require('../utils/cartId');

test('normalizeCartId maps various legacy forms to canonical ID', () => {
  expect(normalizeCartId('CART-01')).toBe('CART_01');
  expect(normalizeCartId('CART_01')).toBe('CART_01');
  expect(normalizeCartId('cart-01')).toBe('CART_01');
  expect(normalizeCartId('CART_1')).toBe('CART_01');
  expect(normalizeCartId('CART01')).toBe('CART_01');
  expect(normalizeCartId('CART-02')).toBe('CART_02');
  expect(normalizeCartId('cart_03')).toBe('CART_03');
});

test('normalizeCartId returns null for unknown identifiers', () => {
  expect(normalizeCartId('UNKNOWN')).toBeNull();
  expect(normalizeCartId('CART_04')).toBeNull();
});
