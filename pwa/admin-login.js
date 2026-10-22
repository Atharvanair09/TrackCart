/**
 * TrackCart Admin OS - Authentication Gateway Controller
 * Communicates with /api/auth endpoints for credentials verification & token storage
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// DOM Elements
const form = document.getElementById('form-admin-login');
const emailInput = document.getElementById('admin-email');
const passwordInput = document.getElementById('admin-password');
const submitBtn = document.getElementById('btn-login-submit');
const togglePwdBtn = document.getElementById('btn-toggle-password');
const fillDemoBtn = document.getElementById('btn-fill-demo');
const alertBox = document.getElementById('login-alert-box');
const alertMsg = document.getElementById('login-alert-msg');
const clockEl = document.getElementById('hud-live-clock');

// 1. Live HUD Clock
function updateClock() {
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = now.toTimeString().split(' ')[0] + ' UTC';
  }
}
setInterval(updateClock, 1000);
updateClock();

// 2. Alert Box Display Helper
function showAlert(message, type = 'info') {
  if (!alertBox || !alertMsg) return;
  alertBox.className = `login-alert alert-${type} font-mono`;
  alertMsg.textContent = message;
}

// 3. Password Show/Hide Toggle
if (togglePwdBtn && passwordInput) {
  togglePwdBtn.addEventListener('click', () => {
    if (passwordInput.type === 'password') {
      passwordInput.type = 'text';
      togglePwdBtn.textContent = 'HIDE';
    } else {
      passwordInput.type = 'password';
      togglePwdBtn.textContent = 'SHOW';
    }
  });
}

// 4. Fill Demo Credentials
if (fillDemoBtn && emailInput && passwordInput) {
  fillDemoBtn.addEventListener('click', () => {
    emailInput.value = 'ojharamakant48@gmail.com';
    passwordInput.value = 'Sahil@1234567';
    showAlert('DEFAULT CREDENTIALS INSERTED // CLICK AUTHENTICATE', 'info');
  });
}

// 5. Automatic Session Verification on Load
async function checkExistingSession() {
  const token = localStorage.getItem('trackcart_admin_token');
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.valid) {
        showAlert('ACTIVE SESSION RECOGNIZED // REDIRECTING TO CONSOLE...', 'success');
        setTimeout(() => {
          window.location.replace('/admin.html');
        }, 600);
      }
    } else {
      // Token is stale or expired
      localStorage.removeItem('trackcart_admin_token');
      localStorage.removeItem('trackcart_admin_user');
    }
  } catch (e) {
    console.warn('[auth] Session verification check skipped:', e.message);
  }
}

// 6. Handle Form Submit
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showAlert('ERROR: BOTH EMAIL AND ACCESS KEY ARE REQUIRED', 'error');
      return;
    }

    // Set UI to loading state
    submitBtn.disabled = true;
    showAlert('INITIALIZING CRYPTOGRAPHIC HANDSHAKE WITH POSTGRESQL...', 'info');

    try {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (response.ok && data.success && data.token) {
        // Save session credentials
        localStorage.setItem('trackcart_admin_token', data.token);
        localStorage.setItem('trackcart_admin_user', JSON.stringify(data.admin));

        showAlert('AUTHENTICATION GRANTED ■ REDIRECTING TO OPERATIONS CONSOLE...', 'success');

        setTimeout(() => {
          window.location.replace('/admin.html');
        }, 700);
      } else {
        submitBtn.disabled = false;
        showAlert(`AUTHENTICATION REJECTED: ${data.message || 'INVALID CREDENTIALS'}`, 'error');
      }
    } catch (err) {
      console.error('Login error:', err);
      submitBtn.disabled = false;
      showAlert('NETWORK ERROR: UNABLE TO REACH AUTHENTICATION BACKEND', 'error');
    }
  });
}

// Check if already authenticated on initial load
checkExistingSession();
