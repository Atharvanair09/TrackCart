const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay instance lazily
let razorpayInstance = null;

function initInstance() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return null;
  }
  if (!razorpayInstance) {
    razorpayInstance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayInstance;
}

/**
 * Checks whether Razorpay credentials are present in the environment.
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
}

/**
 * Creates a Razorpay order.
 * @param {{ amount: number, currency: string, receipt: string }} options
 * @returns {Promise<Object>} Razorpay order object
 */
async function createOrder({ amount, currency = 'INR', receipt }) {
  const instance = initInstance();
  if (!instance) {
    throw new Error('Razorpay not configured');
  }
  // Razorpay expects amount in the smallest currency unit (paise for INR)
  const orderOptions = {
    amount,
    currency,
    receipt,
    payment_capture: 1, // auto-capture
  };
  return await instance.orders.create(orderOptions);
}

/**
 * Verifies Razorpay payment signature.
 * @param {string} orderId
 * @param {string} paymentId
 * @param {string} signature
 * @returns {boolean}
 */
function verifySignature(orderId, paymentId, signature) {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay secret not configured');
  }
  const generatedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return generatedSignature === signature;
}

module.exports = {
  isConfigured,
  createOrder,
  verifySignature,
};
