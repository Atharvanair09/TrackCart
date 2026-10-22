// generate_qrs.js - generate QR code PNGs for each cart
// Run with: npm run genqr (script added to package.json)
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// List of cart identifiers (must match the cart_id values in DB)
const carts = ['CART_01', 'CART_02', 'CART_03'];

(async () => {
  const outDir = path.resolve(__dirname, '..', 'pwa', 'assets', 'qr');
  fs.mkdirSync(outDir, { recursive: true });
  for (const cartId of carts) {
    const fileName = `qr_${cartId.toLowerCase()}.png`;
    const filePath = path.join(outDir, fileName);
    try {
      await QRCode.toFile(filePath, cartId, { width: 300, margin: 2, color: { dark: '#000', light: '#FFF' } });
      console.log(`Generated QR for ${cartId} -> ${filePath}`);
    } catch (err) {
      console.error('Failed to generate QR for', cartId, err);
    }
  }
})();
