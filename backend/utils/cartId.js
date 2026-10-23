// backend/utils/cartId.js
// Centralized cart identifier normalization.
// Accepts various legacy forms and returns the canonical DB identifier (CART_01, CART_02, CART_03).
// Returns null if the identifier cannot be mapped to a known cart.

/**
 * Normalizes a raw cart identifier string to the canonical form.
 * Supported inputs (case‑insensitive):
 *   CART-01, CART_01, cart-01, CART_1, CART01
 * Returns "CART_01", "CART_02", or "CART_03" for the three carts.
 * Any other pattern yields null.
 */
function normalizeCartId(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const cleaned = rawId.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = cleaned.match(/CART0?([1-3])/);
  if (!match) return null;
  return `CART_0${match[1]}`;
}


module.exports = { normalizeCartId };
