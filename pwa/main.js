const API_BASE = import.meta.env.VITE_API_URL || '/api';

// State
let currentSessionId = localStorage.getItem('smart_cart_session_id');
let currentCartId = null;
let currentRazorpayOrder = null;
let pollInterval = null;
let html5QrCode = null;
let isTorchOn = false;
let isScanning = false;

// DOM Elements
const screens = {
  loading: document.getElementById('loading-screen'),
  home: document.getElementById('home-screen'),
  scanner: document.getElementById('scanner-screen'),
  cart: document.getElementById('cart-screen'),
  completed: document.getElementById('completed-screen')
};

// Home Elements
const homeScanBtn = document.getElementById('home-scan-btn');
const homeConnectionStatus = document.getElementById('home-connection-status');

// Scanner Elements
const scannerError = document.getElementById('scanner-error');
const webcamPreview = document.getElementById('webcam-preview');
const manualCartIdInput = document.getElementById('manual-cart-id');
const pairCartBtn = document.getElementById('pair-cart-btn');
const abortScanBtn = document.getElementById('abort-scan-btn');
const toggleTorchBtn = document.getElementById('toggle-torch-btn');
const scannerStatusTag = document.getElementById('scanner-status-tag');

// Cart Ledger Elements
const ledgerCartId = document.getElementById('ledger-cart-id');
const cartOnlineBadge = document.getElementById('cart-online-badge');
const cartError = document.getElementById('cart-error');
const cartItemsList = document.getElementById('cart-items');
const emptyState = document.getElementById('empty-state');
const totalItemsEl = document.getElementById('total-items');
const cartSubtotalEl = document.getElementById('cart-subtotal');
const cartTaxEl = document.getElementById('cart-tax');
const cartTotalEl = document.getElementById('cart-total');
const checkoutTotalBadge = document.getElementById('checkout-total-badge');
const checkoutBtn = document.getElementById('checkout-btn');
const disconnectCartBtn = document.getElementById('disconnect-cart-btn');
const newSessionBtn = document.getElementById('new-session-btn');

// Payment & Bill Elements
const paymentFailedAlert = document.getElementById('payment-failed-alert');
const paymentFailedReason = document.getElementById('payment-failed-reason');
const paymentFailedTime = document.getElementById('payment-failed-time');
const dismissPaymentAlertBtn = document.getElementById('dismiss-payment-alert');

const razorpaySimModal = document.getElementById('razorpay-sim-modal');
const rzpModalAmount = document.getElementById('rzp-modal-amount');
const rzpModalOrderId = document.getElementById('rzp-modal-order-id');
const rzpModalCartId = document.getElementById('rzp-modal-cart-id');
const rzpModalCloseBtn = document.getElementById('rzp-modal-close-btn');
const rzpPaySuccessBtn = document.getElementById('rzp-pay-success-btn');
const rzpPayFailBtn = document.getElementById('rzp-pay-fail-btn');

const billPrintBtn = document.getElementById('bill-print-btn');

// Nav Tabs (both bottom and top bars)
const navTabs = document.querySelectorAll('#bottom-tab-bar .nav-tab, #top-tab-bar .nav-tab');

// Initialize PWA App
function init() {
  setupNavigation();
  if (currentSessionId) {
    showScreen('cart');
    fetchCart(true);
    startPolling();
  } else {
    showScreen('home');
  }
}

// Navigation & Screen Management
function showScreen(screenName) {
  stopCamera();
  
  Object.keys(screens).forEach(key => {
    if (screens[key]) {
      screens[key].classList.add('hidden');
    }
  });

  if (screens[screenName]) {
    screens[screenName].classList.remove('hidden');
  }

  // Update tab highlights
  navTabs.forEach(tab => {
    const target = tab.dataset.target;
    if (target === screenName || (screenName === 'home' && (target === 'home' || target === 'tare' || target === 'cart'))) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  if (screenName === 'scanner') {
    startCamera();
  }
}

function setupNavigation() {
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.target;
      if (target === 'cart' && !currentSessionId) {
        showScreen('home');
      } else {
        showScreen(target);
      }
    });
  });
}

// Format Currency
function formatPrice(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount || 0);
}

// Front‑end normalisation – mirrors backend utils/cartId.js
function normalizeCartIdFrontend(rawId) {
  if (!rawId || typeof rawId !== 'string') return null;
  const cleaned = rawId.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = cleaned.match(/CART0?([1-3])/);
  if (!match) return null;
  return `CART_0${match[1]}`;
}

// Create Session API Call (POST /api/sessions)
async function createSession(cartId) {


  const normalizedId = normalizeCartIdFrontend(cartId);
  if (!normalizedId) {
    showError(scannerError, 'INVALID CART ID – must be CART‑01 / CART‑02 / CART‑03');
    return;
  }

  hideError(scannerError);
  if (pairCartBtn) {
    pairCartBtn.disabled = true;
    pairCartBtn.textContent = 'PAIRING...';
  }

  try {
    const res = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cartId: normalizedId })
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409) {
        throw new Error(`HTTP 409: Cart '${normalizedId}' is already in use by an active session.`);
      } else if (res.status === 404) {
        throw new Error(`HTTP 404: Cart '${normalizedId}' not found in database.`);
      } else {
        throw new Error(data.error || 'Failed to create session');
      }
    }

    currentSessionId = data.session_id;
    localStorage.setItem('smart_cart_session_id', currentSessionId);

    initPush();
  showScreen('cart');
    fetchCart(true);
    startPolling();

  } catch (err) {
    console.error('Error starting session:', err);
    showError(scannerError, err.message.toUpperCase());
    if (homeConnectionStatus) {
      homeConnectionStatus.textContent = 'ERROR';
    }
    // Restart camera if we are still on the scanner screen so they can scan again
    if (!screens.scanner.classList.contains('hidden') && html5QrCode) {
      startCamera();
    }
  } finally {
    if (pairCartBtn) {
      pairCartBtn.disabled = false;
      pairCartBtn.textContent = 'PAIR';
    }
  }
}

// Fetch Cart Ledger API Call (GET /api/sessions/:sessionId)
async function fetchCart(isInitial = false) {
  if (!currentSessionId) return;

  try {
    const res = await fetch(`${API_BASE}/sessions/${currentSessionId}`);

    if (res.status === 404) {
      handleSessionEnded('expired');
      return;
    }

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch cart');
    }

    if (data.status === 'completed' || data.status === 'cancelled') {
      handleSessionEnded(data.status);
      return;
    }

    renderCart(data);
    hideError(cartError);
    if (cartOnlineBadge) {
      cartOnlineBadge.textContent = '■ ONLINE';
      cartOnlineBadge.className = 'hud-badge status-online';
    }

  } catch (error) {
    console.error('Error fetching cart:', error);
    if (isInitial) {
      showError(cartError, 'UNABLE TO CONNECT TO CART LEDGER. RETRYING...');
    }
    if (cartOnlineBadge) {
      cartOnlineBadge.textContent = '■ OFFLINE';
      cartOnlineBadge.className = 'hud-badge status-standby';
    }
  }
}

// Render Cart Ledger View
function friendlyCartName(cartId) {
  // Convert CART_01, CART-01, CART01 etc. to "Cart 1"
  const num = cartId && cartId.match(/\d+/) ? parseInt(cartId.match(/\d+/)[0], 10) : null;
  return num ? `Cart ${num}` : cartId || 'Cart';
}

function renderCart(sessionData) {
  currentCartId = sessionData.cart_id;
  if (ledgerCartId) {
    // Show friendly cart label (e.g., "Cart 1")
    const friendly = friendlyCartName(sessionData.cart_id);
    ledgerCartId.textContent = friendly;
  }

  // Use friendly name in other UI places if needed
  const items = sessionData.items || [];

  // ----- MISMATCH NOTIFICATION LOGIC -----
  // Preserve previous cart total in a closure variable (global in this file)
  if (typeof window._prevCartTotal === 'undefined') {
    window._prevCartTotal = null;
  }
  const currentCartTotal = sessionData.cartTotal || 0;
  const cameraSync = sessionData.cameraSync; // true if recent camera event matched
  // If cart total changed but no camera sync, warn user
  if (window._prevCartTotal !== null && currentCartTotal !== window._prevCartTotal && !cameraSync) {
    showError(cartError, 'CAMERA MISMATCH: Cart changed without camera confirmation');
  } else if (cameraSync && (window._prevCartTotal === null || currentCartTotal === window._prevCartTotal)) {
    // Camera reported a change but cart unchanged – also warn
    showError(cartError, 'CAMERA MISMATCH: Camera detected change but cart unchanged');
  } else {
    hideError(cartError);
  }
  // Update previous total for next comparison
  window._prevCartTotal = currentCartTotal;

  if (items.length === 0) {
    emptyState.classList.remove('hidden');
    cartItemsList.innerHTML = '';
    checkoutBtn.disabled = true;
    totalItemsEl.textContent = '0';
    cartSubtotalEl.textContent = formatPrice(0);
    cartTaxEl.textContent = formatPrice(0);
    cartTotalEl.textContent = formatPrice(0);
    checkoutTotalBadge.textContent = '[$0.00] ->';
  } else {
    emptyState.classList.add('hidden');
    checkoutBtn.disabled = false;

    cartItemsList.innerHTML = items.map((item, index) => {
      const itemNum = String(index + 1).padStart(2, '0');
      const skuCode = item.product_id ? `SKU-${item.product_id.slice(0, 6).toUpperCase()}` : 'SKU-100293';
      const weightDisplay = item.weight_kg ? `${item.weight_kg} kg` : '0.85 kg';
      const unitPriceDisplay = formatPrice(item.unit_price_at_addition || item.price || 0);
      const subtotalDisplay = formatPrice(item.subtotal || (item.unit_price_at_addition * item.quantity));

      return `
        <li class="cart-item-card">
          <div class="item-card-top">
            <span class="item-sku-badge"><strong>#${itemNum}</strong> ${skuCode} • ${weightDisplay}</span>
            <div class="item-prices">
              <div class="item-total-price">${subtotalDisplay}</div>
              <div class="item-unit-price">@ ${unitPriceDisplay} EA</div>
            </div>
          </div>
          <div class="item-title-name">${item.name || 'CART ITEM'}</div>
          <div class="item-optical-tag">■ OPTICAL MATCH // WEIGHT CONFIRMED</div>
          <div class="item-controls-row font-mono">
            <div class="qty-btn-group">
              <button class="qty-btn decrement" data-product-id="${item.product_id}">-</button>
              <span class="qty-val">${item.quantity}</span>
              <button class="qty-btn" disabled>+</button>
            </div>
          </div>
        </li>
      `;
    }).join('');

    const totalCount = items.reduce((sum, item) => sum + item.quantity, 0);
    const subtotal = sessionData.cartTotal || 0;
    const tax = subtotal * 0.0825; // 8.25% Tax rate as shown in specifications
    const totalDue = subtotal + tax;

    totalItemsEl.textContent = totalCount;
    cartSubtotalEl.textContent = formatPrice(subtotal);
    cartTaxEl.textContent = formatPrice(tax);
    cartTotalEl.textContent = formatPrice(totalDue);
    checkoutTotalBadge.textContent = `[${formatPrice(totalDue)}] ->`;
    // Attach decrement button listeners
    document.querySelectorAll('.qty-btn.decrement').forEach(btn => {
      btn.addEventListener('click', () => {
        const productId = btn.dataset.productId;
        decrementItem(productId);
      });
    });
  }
}

// Checkout & End Session
async function decrementItem(productId) {
  if (!currentSessionId) return;
  try {
    const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/items/${productId}/decrement`, {
      method: 'POST'
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to decrement item');
    }
    // Refresh cart view
    fetchCart();
  } catch (error) {
    console.error('Error decrementing item:', error);
    showError(cartError, error.message.toUpperCase());
  }
}

// -------------------------------------------------------------
// Razorpay Checkout Integration
// -------------------------------------------------------------
async function checkout() {
  if (!currentSessionId) return;

  hidePaymentFailedAlert();
  hideError(cartError);

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'CONNECTING TO RAZORPAY...';

  try {
    // 1. Call backend to create Razorpay Order
    const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/create-order`, {
      method: 'POST'
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to initiate checkout order');
    }

    const orderData = await res.json();
    currentRazorpayOrder = orderData;
    if (orderData.cart_id) {
      currentCartId = orderData.cart_id;
    }

    // 2. Open Razorpay Gateway (Real SDK or interactive simulation gateway)
    openRazorpayCheckout(orderData);

  } catch (error) {
    console.error('Error during checkout initiation:', error);
    showError(cartError, error.message.toUpperCase());
    resetCheckoutButton();
  }
}

function resetCheckoutButton() {
  if (checkoutBtn) {
    checkoutBtn.disabled = false;
    checkoutBtn.innerHTML = `
      <span class="square-bullet">■</span>
      <span class="btn-text">PROCEED TO INSTANT CHECKOUT</span>
      <span id="checkout-total-badge" class="total-badge">[RETRY] -&gt;</span>
    `;
  }
}

function openRazorpayCheckout(orderData) {
  const isRealKey = orderData.key_id && orderData.key_id.startsWith('rzp_') && orderData.key_id !== 'rzp_test_placeholder';
  const hasSdk = typeof window.Razorpay === 'function';

  if (!orderData.is_mock && isRealKey && hasSdk) {
    // Official Razorpay Standard Checkout SDK
    try {
      const options = {
        key: orderData.key_id,
        amount: orderData.amount, // in paise
        currency: orderData.currency || 'INR',
        name: 'TrackCart Smart Store',
        description: `Autonomous Cart Checkout (${orderData.cart_id || currentCartId || currentSessionId})`,
        image: '/cart-qr.png',
        order_id: orderData.order_id,
        prefill: {
          name: 'TrackCart Shopper',
          email: 'shopper@trackcart.com',
          contact: '9876543210'
        },
        theme: {
          color: '#000000'
        },
        handler: async function (response) {
          // Razorpay returns razorpay_payment_id, razorpay_order_id, razorpay_signature
          await completeSuccessfulCheckout(response);
        },
        modal: {
          ondismiss: function () {
            handlePaymentFailed('Payment session dismissed. Transaction was not completed.');
          }
        }
      };

      const rzpInstance = new window.Razorpay(options);
      rzpInstance.on('payment.failed', function (errResp) {
        const failureReason = errResp?.error?.description || errResp?.error?.reason || 'Transaction declined by payment gateway';
        handlePaymentFailed(failureReason);
      });
      rzpInstance.open();
      return;
    } catch (sdkError) {
      console.warn('Real Razorpay SDK failed to open, falling back to simulated gateway:', sdkError);
    }
  }

  // Interactive Razorpay Simulation Modal for Local Development and Demonstrations
  openRazorpaySimulationModal(orderData);
}

function openRazorpaySimulationModal(orderData) {
  if (!razorpaySimModal) return;

  const totalAmount = orderData.total !== undefined
    ? formatPrice(orderData.total)
    : `₹${((orderData.amount || 0) / 100).toFixed(2)}`;

  if (rzpModalAmount) rzpModalAmount.textContent = totalAmount;
  if (rzpModalOrderId) rzpModalOrderId.textContent = orderData.order_id || 'order_mock_000';
  if (rzpModalCartId) rzpModalCartId.textContent = orderData.cart_id || currentCartId || 'CART_01';

  razorpaySimModal.classList.remove('hidden');
}

function closeRazorpaySimulationModal() {
  if (razorpaySimModal) {
    razorpaySimModal.classList.add('hidden');
  }
}

// Payment failed: redirect to cart screen and display alert
function handlePaymentFailed(reason = 'Payment was declined or cancelled') {
  closeRazorpaySimulationModal();
  showScreen('cart');
  showPaymentFailedAlert(reason);
  resetCheckoutButton();
}

function showPaymentFailedAlert(reason) {
  if (!paymentFailedAlert) return;
  if (paymentFailedReason) {
    paymentFailedReason.textContent = `${reason}. Your cart items remain safe in your basket. Please try checkout again.`;
  }
  if (paymentFailedTime) {
    const now = new Date();
    paymentFailedTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  paymentFailedAlert.classList.remove('hidden');
  paymentFailedAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hidePaymentFailedAlert() {
  if (paymentFailedAlert) {
    paymentFailedAlert.classList.add('hidden');
  }
}

// Payment succeeded: complete checkout on backend and generate bill
async function completeSuccessfulCheckout(paymentData) {
  closeRazorpaySimulationModal();
  hidePaymentFailedAlert();

  if (checkoutBtn) {
    checkoutBtn.disabled = true;
    checkoutBtn.textContent = 'VERIFYING PAYMENT & GENERATING BILL...';
  }

  try {
    const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_order_id: paymentData.razorpay_order_id,
        razorpay_payment_id: paymentData.razorpay_payment_id,
        razorpay_signature: paymentData.razorpay_signature
      })
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Payment verification failed');
    }

    const saleRecord = await res.json();
    generateAndDisplayBill(saleRecord);

  } catch (error) {
    console.error('Error completing checkout on server:', error);
    handlePaymentFailed(`Payment settlement failed: ${error.message}`);
  }
}

// Generate and Display Official Bill / Tax Invoice
function generateAndDisplayBill(sale) {
  stopPolling();
  currentSessionId = null;
  localStorage.removeItem('smart_cart_session_id');

  // Populate Invoice ID
  const billInvoiceId = document.getElementById('bill-invoice-id');
  if (billInvoiceId) {
    billInvoiceId.textContent = sale.sale_id || `SALE_${Date.now()}`;
  }

  // Populate Date & Time
  const billTimestamp = document.getElementById('bill-timestamp');
  if (billTimestamp) {
    const d = sale.completed_at ? new Date(sale.completed_at) : new Date();
    billTimestamp.textContent = d.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    });
  }

  // Populate Cart Terminal
  const billCartId = document.getElementById('bill-cart-id');
  if (billCartId) {
    billCartId.textContent = sale.cart_id || currentCartId || 'CART_01';
  }

  // Populate Razorpay Payment ID
  const billPaymentId = document.getElementById('bill-payment-id');
  if (billPaymentId) {
    billPaymentId.textContent = sale.payment?.razorpay_payment_id || `pay_${Date.now()}`;
  }

  // Populate Line Items
  const billItemsList = document.getElementById('bill-items-list');
  const billItemsCount = document.getElementById('bill-items-count');
  const items = sale.items || [];
  const totalItemQty = items.reduce((sum, item) => sum + (item.quantity || 1), 0);

  if (billItemsCount) {
    billItemsCount.textContent = totalItemQty;
  }

  if (billItemsList) {
    if (items.length === 0) {
      billItemsList.innerHTML = `<li class="receipt-item-row"><span class="item-name" style="grid-column: span 4; text-align:center; color:#666;">No items recorded</span></li>`;
    } else {
      billItemsList.innerHTML = items.map(item => {
        const unit = item.unit_price || item.price || 0;
        const lineTotal = item.line_subtotal || (unit * item.quantity);
        return `
          <li class="receipt-item-row">
            <span class="item-name">${item.name || item.product_id}</span>
            <span class="item-qty">${item.quantity}</span>
            <span class="item-unit">${formatPrice(unit)}</span>
            <span class="item-subtotal">${formatPrice(lineTotal)}</span>
          </li>
        `;
      }).join('');
    }
  }

  // Populate Financial Totals
  const billSubtotal = document.getElementById('bill-subtotal');
  const billTax = document.getElementById('bill-tax');
  const billTotal = document.getElementById('bill-total');

  if (billSubtotal) billSubtotal.textContent = formatPrice(sale.subtotal || 0);
  if (billTax) billTax.textContent = formatPrice(sale.tax_amount || 0);
  if (billTotal) billTotal.textContent = formatPrice(sale.total || 0);

  // Security Exit Token
  const billToken = document.getElementById('bill-token');
  if (billToken) {
    const randomHex = Math.random().toString(36).substring(2, 8).toUpperCase();
    billToken.textContent = `TOKEN: AUTH-OK-${randomHex}`;
  }

  showScreen('completed');
  if (checkoutBtn) {
    checkoutBtn.disabled = false;
  }
}

// Disconnect Session
async function disconnectSession() {
  if (!currentSessionId) {
    showScreen('home');
    return;
  }

  try {
    await fetch(`${API_BASE}/sessions/${currentSessionId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.warn('Disconnect request error:', err);
  } finally {
    handleSessionEnded('cancelled');
  }
}

function handleSessionEnded(status = 'completed') {
  stopPolling();
  currentSessionId = null;
  localStorage.removeItem('smart_cart_session_id');

  if (status === 'cancelled') {
    showScreen('home');
  } else {
    showScreen('home');
  }

  if (checkoutBtn) {
    checkoutBtn.disabled = false;
  }
}

// Polling Logic
function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => fetchCart(), 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// WebRTC Camera & QR Scanner Handler
async function startCamera() {
  stopCamera();
  hideError(scannerError);

  if (scannerStatusTag) {
    scannerStatusTag.textContent = '■ ACTIVE';
    scannerStatusTag.className = 'hud-badge status-online';
  }

  try {
    if (!html5QrCode) {
      html5QrCode = new Html5Qrcode("webcam-preview");
    }

    isScanning = true;
    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 10,
      },
      (decodedText) => {
        if (!isScanning) return;
        
        const rawScanned = decodedText.trim();
        const normalizedId = normalizeCartIdFrontend(rawScanned);
        if (normalizedId) {
          console.log('QR Code Scanned and normalized:', normalizedId);
          stopCamera();
          createSession(normalizedId);
        } else {
          showError(scannerError, `INVALID QR CONTENT: ${rawScanned}`);
        }
      
      },
      (errorMessage) => {
        // Ignore continuous scan parse errors
      }
    );

  } catch (err) {
    console.warn('Camera access error or restricted environment:', err);
    showError(scannerError, 'OPTICAL SENSOR UNAVAILABLE OR PERMISSION DENIED. USE MANUAL PAIRING BELOW.');
    if (scannerStatusTag) {
      scannerStatusTag.textContent = '■ MANUAL FALLBACK';
      scannerStatusTag.className = 'hud-badge status-standby';
    }
  }
}

function stopCamera() {
  isScanning = false;
  if (html5QrCode && html5QrCode.isScanning) {
    html5QrCode.stop().then(() => {
      console.log("Camera stopped");
    }).catch((err) => {
      console.warn("Error stopping camera", err);
    });
  }
  isTorchOn = false;
  if (toggleTorchBtn) {
    toggleTorchBtn.textContent = '🔦 TORCH: OFF';
  }
}

function toggleTorch() {
  if (html5QrCode && html5QrCode.isScanning) {
    isTorchOn = !isTorchOn;
    html5QrCode.applyVideoConstraints({
      advanced: [{ torch: isTorchOn }]
    }).then(() => {
      toggleTorchBtn.textContent = `🔦 TORCH: ${isTorchOn ? 'ON' : 'OFF'}`;
    }).catch(err => {
      console.warn('Torch constraint error:', err);
      toggleTorchBtn.textContent = `🔦 TORCH: ${isTorchOn ? 'ON' : 'OFF'} (SIM)`;
    });
  }
}

// Utility Functions
function showError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.remove('hidden');
}

function hideError(element) {
  if (!element) return;
  element.classList.add('hidden');
}

// Event Listeners
homeScanBtn.addEventListener('click', () => showScreen('scanner'));

pairCartBtn.addEventListener('click', () => {
  const val = manualCartIdInput.value.trim();
  createSession(val);
});

manualCartIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    createSession(manualCartIdInput.value.trim());
  }
});

abortScanBtn.addEventListener('click', () => showScreen('home'));
toggleTorchBtn.addEventListener('click', toggleTorch);
checkoutBtn.addEventListener('click', checkout);
disconnectCartBtn.addEventListener('click', disconnectSession);

// Dismiss payment alert
if (dismissPaymentAlertBtn) {
  dismissPaymentAlertBtn.addEventListener('click', hidePaymentFailedAlert);
}

// Razorpay simulation modal actions
if (rzpModalCloseBtn) {
  rzpModalCloseBtn.addEventListener('click', () => {
    handlePaymentFailed('Payment cancelled by user');
  });
}

if (rzpPayFailBtn) {
  rzpPayFailBtn.addEventListener('click', () => {
    handlePaymentFailed('Simulated payment failure: Transaction declined by bank / insufficient funds');
  });
}

if (rzpPaySuccessBtn) {
  rzpPaySuccessBtn.addEventListener('click', () => {
    const randSuffix = Math.random().toString(36).substring(2, 12);
    completeSuccessfulCheckout({
      razorpay_payment_id: `pay_sim_${randSuffix}`,
      razorpay_order_id: currentRazorpayOrder?.order_id || `order_mock_${Date.now()}`,
      razorpay_signature: `sig_sim_${randSuffix}`
    });
  });
}

// Print Bill Action
if (billPrintBtn) {
  billPrintBtn.addEventListener('click', () => {
    window.print();
  });
}

newSessionBtn.addEventListener('click', () => {
  currentSessionId = null;
  currentCartId = null;
  currentRazorpayOrder = null;
  localStorage.removeItem('smart_cart_session_id');
  hidePaymentFailedAlert();
  showScreen('home');
});

// Boot Application
init();
