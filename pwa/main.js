const API_BASE = import.meta.env.VITE_API_URL || '/api';

// State
let currentSessionId = localStorage.getItem('smart_cart_session_id');
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

// Create Session API Call (POST /api/sessions)
async function createSession(cartId) {
  // Front‑end normalisation – mirrors backend utils/cartId.js
  function normalizeCartIdFrontend(rawId) {
    if (!rawId || typeof rawId !== 'string') return null;
    const cleaned = rawId.toUpperCase().replace(/[^A-Z0-9]/g, ''); // strip non‑alphanum
    const match = cleaned.match(/^CART0?(\\d)$/);
    if (!match) return null;
    const num = parseInt(match[1], 10);
    if (num >= 1 && num <= 3) {
      return `CART_0${num}`; // canonical DB id
    }
    return null;
  }

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
        throw new Error(`HTTP 409: Cart '${cleanCartId}' is already in use by an active session.`);
      } else if (res.status === 404) {
        throw new Error(`HTTP 404: Cart '${cleanCartId}' not found in database.`);
      } else {
        throw new Error(data.error || 'Failed to create session');
      }
    }

    currentSessionId = data.session_id;
    localStorage.setItem('smart_cart_session_id', currentSessionId);

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
  if (ledgerCartId) {
    // Show friendly cart label (e.g., "Cart 1")
    const friendly = friendlyCartName(sessionData.cart_id);
    ledgerCartId.textContent = friendly;
  }

  // Use friendly name in other UI places if needed
  const items = sessionData.items || [];

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
  } catch (error) {ś
    console.error('Error decrementing item:', error);
    showError(cartError, error.message.toUpperCase());
  }
}

async function checkout() {
  if (!currentSessionId) return;

  checkoutBtn.disabled = true;
  checkoutBtn.textContent = 'PROCESSING CHECKOUT...';

  try {
    const res = await fetch(`${API_BASE}/sessions/${currentSessionId}/checkout`, {
      method: 'POST'
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to complete checkout');
    }

    handleSessionEnded('completed');

  } catch (error) {
    showError(cartError, error.message.toUpperCase());
    checkoutBtn.disabled = false;
    checkoutBtn.textContent = 'PROCEED TO INSTANT CHECKOUT';
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

  const title = document.getElementById('completed-title');
  const msg = document.getElementById('completed-message');

  if (status === 'cancelled') {
    title.textContent = 'SESSION DISCONNECTED';
    msg.textContent = 'Your cart session has been ended.';
  } else {
    title.textContent = 'SHOPPING COMPLETED';
    msg.textContent = 'Thank you for shopping! Transaction recorded.';
  }

  showScreen('completed');
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
        
        const cleanCartId = decodedText.trim().toUpperCase();
        if (/^[\w-]+$/.test(cleanCartId)) {
          console.log('QR Code Scanned:', cleanCartId);
          stopCamera();
          createSession(cleanCartId);
        } else {
          showError(scannerError, `INVALID QR CONTENT: ${cleanCartId}`);
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

newSessionBtn.addEventListener('click', () => {
  currentSessionId = null;
  localStorage.removeItem('smart_cart_session_id');
  showScreen('home');
});

// Boot Application
init();
