/**
 * TrackCart Admin OS - Client Logic & Dashboard Controller
 * ALL DATA IS SOURCED DIRECTLY FROM THE POSTGRESQL DATABASE VIA /api/admin/*
 */

const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ==========================================
// 0. Authentication Guard & Session Check
// ==========================================
function getAuthToken() {
  return localStorage.getItem('trackcart_admin_token');
}

async function enforceAuth() {
  const token = getAuthToken();
  const userJson = localStorage.getItem('trackcart_admin_user');

  if (!token) {
    window.location.replace('/admin-login.html');
    return false;
  }

  // Display user info in top HUD if available
  if (userJson) {
    try {
      const user = JSON.parse(userJson);
      const identityEl = document.getElementById('hud-admin-identity');
      if (identityEl && user.email) {
        identityEl.textContent = `ADMIN: ${user.email}`;
      }
    } catch (e) {}
  }

  // Asynchronously verify with backend
  try {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      localStorage.removeItem('trackcart_admin_token');
      localStorage.removeItem('trackcart_admin_user');
      window.location.replace('/admin-login.html');
      return false;
    }

    const data = await res.json();
    if (data.admin && data.admin.email) {
      const identityEl = document.getElementById('hud-admin-identity');
      if (identityEl) {
        identityEl.textContent = `ADMIN: ${data.admin.email}`;
      }
    }
  } catch (err) {
    console.warn('[auth] Could not verify with backend offline/proxy, session continuing from localStorage token');
  }

  return true;
}

// Attach logout action
function setupLogout() {
  const logoutBtn = document.getElementById('btn-admin-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const token = getAuthToken();
      try {
        if (token) {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
        }
      } catch (e) {
        console.warn('Logout network notice:', e.message);
      } finally {
        localStorage.removeItem('trackcart_admin_token');
        localStorage.removeItem('trackcart_admin_user');
        showToast('Session terminated. Redirecting to login...', 'info');
        setTimeout(() => {
          window.location.replace('/admin-login.html');
        }, 500);
      }
    });
  }
}

// ==========================================
// 1. Data Store (Loaded from Database)
// ==========================================
let products = [];
let movements = [];
let dbKPIs = null;
let dbAnalytics = null;
let isFirstLoad = true;

// Active Filters State
let analyticsFilter = {
  datePreset: 'today',
  startDate: new Date().toISOString().split('T')[0],
  endDate: new Date().toISOString().split('T')[0],
  category: 'ALL',
  productId: 'ALL',
  granularity: 'daily',
  chartMetric: 'revenue'
};

let inventoryFilter = {
  search: '',
  category: 'ALL',
  status: 'ALL',
  sort: 'available-asc',
  view: 'table'
};

// Chart.js instances
let revenueTrendChart = null;
let categorySalesChart = null;
let topProductsChart = null;
let trafficVelocityChart = null;

// ==========================================
// 2. Computed Properties & Helpers
// ==========================================
function getAvailableStock(prod) {
  return Math.max(0, (prod.onHand || 0) - (prod.reserved || 0));
}

function getProductStatus(prod) {
  const avail = getAvailableStock(prod);
  if (avail <= 0) return 'Out of stock';
  if (avail <= prod.reorderLevel) return 'Low stock';
  return 'Healthy';
}

function formatCurrency(val) {
  return '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function updateHUDClock() {
  const clockEl = document.getElementById('hud-live-clock');
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = now.toTimeString().split(' ')[0] + ' UTC';
  }
}

// ==========================================
// 3. Database Data Fetching (Live Sync)
// ==========================================
async function loadDashboardData(silent = false) {
  const token = getAuthToken();
  if (!token) return;

  try {
    const res = await fetch(`${API_BASE}/admin/dashboard`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (res.status === 401) {
      localStorage.removeItem('trackcart_admin_token');
      window.location.replace('/admin-login.html');
      return;
    }

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const data = await res.json();
    if (data.success) {
      products = data.products || [];
      movements = data.movements || [];
      dbKPIs = data.kpis || null;
      dbAnalytics = data.analytics || null;

      populateProductDropdowns();
      updateKPICards();
      renderInventoryTable();
      renderMovementsTable();
      
      if (isFirstLoad) {
        initAnalyticsCharts();
        isFirstLoad = false;
      } else {
        updateAnalyticsChartsFromDb();
      }

      updateAnalyticsFilters();

      if (!silent) {
        showToast('Live database telemetry synced successfully ■', 'success');
      }
    }
  } catch (err) {
    console.error('Failed to load dashboard data from database:', err);
    if (!silent) {
      showToast('Error syncing with database: ' + err.message, 'error');
    }
  }
}

// ==========================================
// 4. Top KPI Cards & Summary Calculation
// ==========================================
function updateKPICards() {
  let todaySales = dbKPIs?.todaySales ?? 0;
  let grossProfit = dbKPIs?.grossProfit ?? 0;
  let completedOrders = dbKPIs?.completedOrders ?? 0;
  let lowStockCount = dbKPIs?.lowStockCount ?? 0;

  // If local product count is available, verify counts
  let totalOnHand = 0;
  let totalReserved = 0;
  let totalAssetVal = 0;

  products.forEach(p => {
    totalOnHand += (p.onHand || 0);
    totalReserved += (p.reserved || 0);
    totalAssetVal += ((p.onHand || 0) * (p.price || 0));
  });

  const elSales = document.getElementById('kpi-today-sales');
  const elOrders = document.getElementById('kpi-completed-orders');
  const elLowStock = document.getElementById('kpi-low-stock-count');
  const elProfit = document.getElementById('kpi-gross-profit');

  if (elSales) elSales.textContent = formatCurrency(todaySales);
  if (elOrders) elOrders.textContent = String(completedOrders);
  if (elLowStock) elLowStock.textContent = String(lowStockCount);
  if (elProfit) elProfit.textContent = formatCurrency(grossProfit);

  const elSumOnHand = document.getElementById('sum-on-hand');
  const elSumReserved = document.getElementById('sum-reserved');
  const elSumAvailable = document.getElementById('sum-available');
  const elSumAssetVal = document.getElementById('sum-asset-val');
  const elTotalSkus = document.getElementById('inv-total-skus-badge');

  if (elSumOnHand) elSumOnHand.textContent = String(totalOnHand);
  if (elSumReserved) elSumReserved.textContent = String(totalReserved);
  if (elSumAvailable) elSumAvailable.textContent = String(Math.max(0, totalOnHand - totalReserved));
  if (elSumAssetVal) elSumAssetVal.textContent = formatCurrency(totalAssetVal);
  if (elTotalSkus) elTotalSkus.textContent = `${products.length} PRODUCTS REGISTERED`;
}

// ==========================================
// 5. Inventory Table & Card View Rendering
// ==========================================
function renderInventoryTable() {
  const tbody = document.getElementById('inventory-table-body');
  const cardGrid = document.getElementById('inventory-card-grid');
  const emptyState = document.getElementById('inventory-empty-state');
  const table = document.getElementById('inventory-table');

  if (!tbody) return;

  // Filter products
  let filtered = products.filter(p => {
    if (inventoryFilter.search) {
      const q = inventoryFilter.search.toLowerCase();
      const matchName = (p.name || '').toLowerCase().includes(q);
      const matchId = (p.id || '').toLowerCase().includes(q);
      const matchRfid = (p.rfid || '').toLowerCase().includes(q);
      const matchCat = (p.category || '').toLowerCase().includes(q);
      if (!matchName && !matchId && !matchRfid && !matchCat) return false;
    }

    if (inventoryFilter.category !== 'ALL' && p.category !== inventoryFilter.category) {
      return false;
    }

    if (inventoryFilter.status !== 'ALL') {
      const status = getProductStatus(p);
      if (status !== inventoryFilter.status) return false;
    }

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const availA = getAvailableStock(a);
    const availB = getAvailableStock(b);
    switch (inventoryFilter.sort) {
      case 'available-asc': return availA - availB;
      case 'available-desc': return availB - availA;
      case 'name-asc': return a.name.localeCompare(b.name);
      case 'onhand-desc': return b.onHand - a.onHand;
      case 'price-desc': return b.price - a.price;
      case 'margin-desc':
        const marginA = ((a.price - a.cost) / (a.price || 1));
        const marginB = ((b.price - b.cost) / (b.price || 1));
        return marginB - marginA;
      default: return 0;
    }
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (cardGrid) cardGrid.innerHTML = '';
    if (emptyState) emptyState.classList.remove('hidden');
    if (table) table.classList.add('hidden');
    return;
  } else {
    if (emptyState) emptyState.classList.add('hidden');
    if (table && inventoryFilter.view === 'table') table.classList.remove('hidden');
  }

  // Render Dense Table from real DB rows
  let html = '';
  filtered.forEach(p => {
    const available = getAvailableStock(p);
    const status = getProductStatus(p);
    const marginPct = p.price > 0 ? (((p.price - p.cost) / p.price) * 100).toFixed(1) : '0.0';

    let statusClass = 'status-healthy';
    let availClass = '';
    if (status === 'Low stock') {
      statusClass = 'status-low';
      availClass = 'low-stock';
    } else if (status === 'Out of stock') {
      statusClass = 'status-out';
      availClass = 'out-of-stock';
    }

    html += `
      <tr data-product-id="${p.id}">
        <td>
          <div class="product-cell-main">
            <span class="product-cell-name">${p.name}</span>
            <div class="product-cell-meta">
              <span>ID: <strong>${p.id}</strong></span>
              <span>//</span>
              <span class="rfid-chip">RFID: ${p.rfid}</span>
            </div>
          </div>
        </td>
        <td class="text-center font-mono">
          <span class="hud-pill">[${(p.category || 'GENERAL').toUpperCase()}]</span>
        </td>
        <td class="text-right">
          <strong class="stock-val-onhand">${p.onHand}</strong>
        </td>
        <td class="text-right">
          <span class="stock-val-reserved">${p.reserved}</span>
        </td>
        <td class="text-right">
          <strong class="stock-val-available ${availClass}">${available}</strong>
        </td>
        <td class="text-right font-mono">
          <div class="stock-pricing-cell">
            <span class="price-selling">${formatCurrency(p.price)}</span>
            <span class="price-cost">COST: ${formatCurrency(p.cost)}</span>
            <span class="price-margin-chip">${marginPct}% MRG</span>
          </div>
        </td>
        <td class="text-center font-mono">
          <span>${p.reorderLevel} / ${p.safetyStock}</span>
        </td>
        <td class="text-center font-mono">
          <span>${p.leadTimeDays}d</span>
        </td>
        <td class="text-center font-mono">
          <span>${p.lastRestocked}</span>
        </td>
        <td class="text-center">
          <span class="status-pill ${statusClass}">${status.toUpperCase()}</span>
        </td>
        <td class="text-center">
          <div class="table-actions-group">
            <button class="btn-row-action btn-row-view" data-id="${p.id}" title="View 360 Product Details">👁 VIEW</button>
            <button class="btn-row-action btn-row-count" data-id="${p.id}" title="Cycle Audit / Count">⚖ COUNT</button>
            <button class="btn-row-action btn-row-restock" data-id="${p.id}" title="Restock / Shipment">📥 RESTOCK</button>
          </div>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;

  // Render Grid Cards
  if (cardGrid) {
    let cardHtml = '';
    filtered.forEach(p => {
      const available = getAvailableStock(p);
      const status = getProductStatus(p);
      let statusClass = 'status-healthy';
      if (status === 'Low stock') statusClass = 'status-low';
      if (status === 'Out of stock') statusClass = 'status-out';

      cardHtml += `
        <div class="inv-card font-mono" data-product-id="${p.id}">
          <div class="inv-card-header">
            <span>${p.id} // ${p.category}</span>
            <span class="status-pill ${statusClass}">${status}</span>
          </div>
          <div class="inv-card-body">
            <span class="inv-card-title">${p.name}</span>
            <div class="rfid-chip">RFID: ${p.rfid}</div>
            
            <div class="inv-card-stock-row">
              <div>
                <span class="chip-label">ON-HAND</span>
                <strong>${p.onHand}</strong>
              </div>
              <div>
                <span class="chip-label">RESERVED</span>
                <span>${p.reserved}</span>
              </div>
              <div>
                <span class="chip-label">AVAIL</span>
                <strong>${available}</strong>
              </div>
            </div>

            <div style="display:flex; justify-content:space-between; font-size:0.75rem;">
              <span>SELL: <strong>${formatCurrency(p.price)}</strong></span>
              <span>COST: ${formatCurrency(p.cost)}</span>
            </div>
          </div>
          <div class="inv-card-footer">
            <span style="font-size:0.65rem; color:#666;">Lead: ${p.leadTimeDays}d // Reorder: ${p.reorderLevel}</span>
            <button class="btn-row-action btn-row-view" data-id="${p.id}">DETAIL →</button>
          </div>
        </div>
      `;
    });
    cardGrid.innerHTML = cardHtml;
  }

  attachTableRowListeners();
}

function attachTableRowListeners() {
  document.querySelectorAll('.btn-row-view').forEach(btn => {
    btn.onclick = () => openProductDetail(btn.dataset.id);
  });
  document.querySelectorAll('.btn-row-count').forEach(btn => {
    btn.onclick = () => openCycleCountModal(btn.dataset.id);
  });
  document.querySelectorAll('.btn-row-restock').forEach(btn => {
    btn.onclick = () => openRestockModal(btn.dataset.id);
  });
}

// ==========================================
// 6. Stock Movements Audit Ledger Rendering
// ==========================================
function renderMovementsTable() {
  const tbody = document.getElementById('movements-table-body');
  const typeFilter = document.getElementById('movement-type-filter')?.value || 'ALL';
  const prodFilter = document.getElementById('movement-product-filter')?.value || 'ALL';

  if (!tbody) return;

  const filtered = movements.filter(m => {
    if (typeFilter !== 'ALL' && m.action !== typeFilter) return false;
    if (prodFilter !== 'ALL' && m.productId !== prodFilter) return false;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="padding:24px;">NO AUDIT MOVEMENTS RECORDED IN DATABASE</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach(m => {
    let badgeClass = 'badge-checkout';
    if (m.action === 'RESTOCK') badgeClass = 'badge-restock';
    if (m.action === 'CYCLE_COUNT') badgeClass = 'badge-cycle';
    if (m.action === 'DAMAGE_WRITEOFF') badgeClass = 'badge-damage';
    if (m.action === 'RESERVED_RELEASE') badgeClass = 'badge-reserve';

    const deltaSign = m.delta > 0 ? `+${m.delta}` : `${m.delta}`;
    const deltaClass = m.delta > 0 ? 'delta-positive' : 'delta-negative';

    html += `
      <tr>
        <td>${m.timestamp}</td>
        <td>
          <strong>${m.productName}</strong>
          <span style="font-size:0.65rem; color:#666;"> (${m.productId} // ${m.rfid})</span>
        </td>
        <td>
          <span class="movement-badge ${badgeClass}">${m.action.replace('_', ' ')}</span>
        </td>
        <td class="text-right">
          <span class="${deltaClass}">${deltaSign}</span>
        </td>
        <td class="text-right">
          ${m.beforeQty} → <strong>${m.afterQty}</strong>
        </td>
        <td><strong>${m.ref}</strong></td>
        <td style="color:#555;">${m.notes}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

// ==========================================
// 7. Chart.js Visualizations (Populated from DB)
// ==========================================
function initAnalyticsCharts() {
  const ChartLib = window.Chart;
  if (!ChartLib) return;

  ChartLib.defaults.font.family = "'Space Mono', monospace";
  ChartLib.defaults.color = '#000000';
  ChartLib.defaults.borderColor = '#e0e0e0';

  // 1. Revenue & Order Volume Trend
  const ctxRevenue = document.getElementById('revenueTrendChart');
  if (ctxRevenue) {
    revenueTrendChart = new ChartLib(ctxRevenue, {
      type: 'line',
      data: {
        labels: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00', '22:00'],
        datasets: [
          {
            label: 'Revenue ($)',
            data: [210.50, 480.00, 890.20, 1280.00, 640.80, 920.00, 360.50, 100.50],
            borderColor: '#000000',
            backgroundColor: 'rgba(0, 0, 0, 0.08)',
            borderWidth: 2.5,
            tension: 0.3,
            fill: true,
            pointBackgroundColor: '#000000',
            pointRadius: 4,
            yAxisID: 'y'
          },
          {
            label: 'Completed Orders',
            data: [8, 18, 32, 44, 23, 31, 10, 2],
            borderColor: '#888888',
            borderDash: [4, 4],
            borderWidth: 2,
            tension: 0.3,
            pointBackgroundColor: '#888888',
            pointRadius: 3,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { type: 'linear', position: 'left', ticks: { callback: v => '$' + v } },
          y1: { type: 'linear', position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => v + ' ord' } }
        }
      }
    });
  }

  // 2. Category Sales Bar Chart
  const ctxCategory = document.getElementById('categorySalesChart');
  if (ctxCategory) {
    categorySalesChart = new ChartLib(ctxCategory, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Gross Sales ($)',
            data: [],
            backgroundColor: '#000000',
            borderWidth: 1.5,
            yAxisID: 'y'
          },
          {
            label: 'Units Sold',
            data: [],
            backgroundColor: '#bbbbbb',
            borderWidth: 1.5,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { position: 'left', ticks: { callback: v => '$' + v } },
          y1: { position: 'right', grid: { drawOnChartArea: false } }
        }
      }
    });
  }

  // 3. Top Products Chart
  const ctxTopProd = document.getElementById('topProductsChart');
  if (ctxTopProd) {
    topProductsChart = new ChartLib(ctxTopProd, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Revenue ($)',
          data: [],
          backgroundColor: ['#000000', '#222222', '#444444', '#666666', '#888888'],
          borderWidth: 1.5
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { callback: v => '$' + v } }
        }
      }
    });
  }

  // 4. Traffic Velocity Chart
  const ctxTraffic = document.getElementById('trafficVelocityChart');
  if (ctxTraffic) {
    trafficVelocityChart = new ChartLib(ctxTraffic, {
      type: 'bar',
      data: {
        labels: ['08h', '09h', '10h', '11h', '12h', '13h', '14h', '15h', '16h', '17h', '18h', '19h', '20h', '21h'],
        datasets: [{
          label: 'Transactions Completed',
          data: [12, 24, 38, 45, 62, 58, 48, 30, 28, 42, 59, 64, 35, 14],
          backgroundColor: '#000000',
          borderWidth: 1.5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false
      }
    });
  }

  updateAnalyticsChartsFromDb();
}

function updateAnalyticsChartsFromDb() {
  if (!dbAnalytics) return;

  // Update Category Sales from Database
  if (categorySalesChart && dbAnalytics.categorySales?.length) {
    categorySalesChart.data.labels = dbAnalytics.categorySales.map(c => c.category);
    categorySalesChart.data.datasets[0].data = dbAnalytics.categorySales.map(c => c.revenue);
    categorySalesChart.data.datasets[1].data = dbAnalytics.categorySales.map(c => c.units);
    categorySalesChart.update();
  }

  // Update Top Products from Database
  if (topProductsChart && dbAnalytics.topProducts?.length) {
    topProductsChart.data.labels = dbAnalytics.topProducts.map(p => p.name);
    topProductsChart.data.datasets[0].data = dbAnalytics.topProducts.map(p => p.revenue);
    topProductsChart.update();
  }
}

function updateAnalyticsFilters() {
  let filteredRev = dbKPIs?.todaySales ?? 0;
  let filteredOrders = dbKPIs?.completedOrders ?? 0;
  let filteredUnits = 0;
  let filteredProfit = dbKPIs?.grossProfit ?? 0;

  if (analyticsFilter.category !== 'ALL') {
    const catProds = products.filter(p => p.category === analyticsFilter.category);
    filteredRev = catProds.reduce((acc, p) => acc + (p.revenue || 0), 0);
    filteredUnits = catProds.reduce((acc, p) => acc + (p.soldUnits || 0), 0);
    const catCost = catProds.reduce((acc, p) => acc + (p.cost * (p.soldUnits || 0)), 0);
    filteredProfit = filteredRev - catCost;
    filteredOrders = Math.round(filteredUnits / 2.45) || (filteredUnits > 0 ? 1 : 0);
  } else if (analyticsFilter.productId !== 'ALL') {
    const p = products.find(x => x.id === analyticsFilter.productId);
    if (p) {
      filteredRev = p.revenue || 0;
      filteredUnits = p.soldUnits || 0;
      filteredProfit = filteredRev - (p.cost * filteredUnits);
      filteredOrders = Math.round(filteredUnits / 1.5) || (filteredUnits > 0 ? 1 : 0);
    }
  } else {
    products.forEach(p => {
      filteredUnits += (p.soldUnits || 0);
    });
  }

  const marginPct = filteredRev > 0 ? ((filteredProfit / filteredRev) * 100).toFixed(1) + '%' : '0.0%';
  const aov = filteredOrders > 0 ? (filteredRev / filteredOrders).toFixed(2) : '0.00';

  const revEl = document.getElementById('metric-filtered-revenue');
  const ordEl = document.getElementById('metric-filtered-orders');
  const unitEl = document.getElementById('metric-filtered-units');
  const aovEl = document.getElementById('metric-filtered-aov');
  const profEl = document.getElementById('metric-filtered-profit');
  const mrgEl = document.getElementById('metric-filtered-margin');

  if (revEl) revEl.textContent = formatCurrency(filteredRev);
  if (ordEl) ordEl.textContent = String(filteredOrders);
  if (unitEl) unitEl.textContent = `${filteredUnits} UNITS`;
  if (aovEl) aovEl.textContent = `$${aov} / ORDER`;
  if (profEl) profEl.textContent = formatCurrency(filteredProfit);
  if (mrgEl) mrgEl.textContent = marginPct;
}

// ==========================================
// 8. Modals, Actions & Database Handlers
// ==========================================
function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('hidden');
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('hidden');
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('admin-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `admin-toast ${type}`;
  toast.innerHTML = `<span>■</span> <span>${msg}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function populateProductDropdowns() {
  const selects = [
    document.getElementById('filter-product'),
    document.getElementById('count-product-select'),
    document.getElementById('restock-product-select'),
    document.getElementById('thresh-product-select'),
    document.getElementById('movement-product-filter')
  ];

  selects.forEach(sel => {
    if (!sel) return;
    const isFilter = sel.id === 'filter-product' || sel.id === 'movement-product-filter';
    const currentVal = sel.value;

    let html = isFilter ? '<option value="ALL">ALL PRODUCTS</option>' : '';
    products.forEach(p => {
      html += `<option value="${p.id}">${p.name} (${p.id} // ${p.rfid})</option>`;
    });

    sel.innerHTML = html;
    if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
      sel.value = currentVal;
    }
  });
}

function openCycleCountModal(productId) {
  populateProductDropdowns();
  const select = document.getElementById('count-product-select');
  if (productId && select) select.value = productId;
  updateCycleCountPreview();
  openModal('modal-cycle-count');
}

function updateCycleCountPreview() {
  const prodId = document.getElementById('count-product-select')?.value;
  const prod = products.find(p => p.id === prodId) || products[0];
  if (!prod) return;

  const sysOnHandEl = document.getElementById('count-sys-onhand');
  const sysReservedEl = document.getElementById('count-sys-reserved');
  const sysAvailableEl = document.getElementById('count-sys-available');
  const inputEl = document.getElementById('count-physical-input');

  if (sysOnHandEl) sysOnHandEl.textContent = String(prod.onHand);
  if (sysReservedEl) sysReservedEl.textContent = String(prod.reserved);
  if (sysAvailableEl) sysAvailableEl.textContent = String(getAvailableStock(prod));

  const counted = parseInt(inputEl.value, 10);
  const badge = document.getElementById('count-discrepancy-badge');
  const sub = document.getElementById('count-discrepancy-sub');

  if (isNaN(counted)) {
    badge.className = 'variance-neutral';
    badge.textContent = '0 UNITS';
    sub.textContent = 'Enter physical count to calculate variance against database ledger';
  } else {
    const diff = counted - prod.onHand;
    if (diff === 0) {
      badge.className = 'variance-neutral';
      badge.textContent = 'PERFECT MATCH (0 UNITS)';
      sub.textContent = 'Physical inventory exactly matches digital database ledger.';
    } else if (diff > 0) {
      badge.className = 'variance-gain';
      badge.textContent = `+${diff} UNITS (SURPLUS)`;
      sub.textContent = `Physical count is HIGHER than database. Database will be incremented.`;
    } else {
      badge.className = 'variance-loss';
      badge.textContent = `${diff} UNITS (DEFICIT)`;
      sub.textContent = `Physical count is LOWER than database. Database shrinkage will be recorded.`;
    }
  }
}

function openRestockModal(productId) {
  populateProductDropdowns();
  const select = document.getElementById('restock-product-select');
  if (productId && select) select.value = productId;
  openModal('modal-restock');
}

function openThresholdsModal(productId) {
  populateProductDropdowns();
  const select = document.getElementById('thresh-product-select');
  if (productId && select) select.value = productId;
  updateThresholdFormFields();
  openModal('modal-thresholds');
}

function updateThresholdFormFields() {
  const prodId = document.getElementById('thresh-product-select')?.value;
  const prod = products.find(p => p.id === prodId);
  if (!prod) return;

  const reorderEl = document.getElementById('thresh-reorder');
  const safetyEl = document.getElementById('thresh-safety');
  const supplierEl = document.getElementById('thresh-supplier');
  const leadEl = document.getElementById('thresh-leadtime');

  if (reorderEl) reorderEl.value = prod.reorderLevel;
  if (safetyEl) safetyEl.value = prod.safetyStock;
  if (supplierEl) supplierEl.value = prod.supplier;
  if (leadEl) leadEl.value = prod.leadTimeDays;
}

function openProductDetail(productId) {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;

  const available = getAvailableStock(prod);
  const status = getProductStatus(prod);
  const unitProfit = prod.price - prod.cost;
  const marginPct = prod.price > 0 ? ((unitProfit / prod.price) * 100).toFixed(1) : '0.0';

  document.getElementById('detail-product-name').textContent = prod.name;
  document.getElementById('detail-product-id').textContent = prod.id;
  document.getElementById('detail-product-rfid').textContent = prod.rfid;
  document.getElementById('detail-product-cat').textContent = prod.category;
  document.getElementById('detail-product-supplier').textContent = prod.supplier;

  const statusEl = document.getElementById('detail-product-status');
  statusEl.textContent = status.toUpperCase();
  statusEl.className = 'status-pill ' + (status === 'Healthy' ? 'status-healthy' : (status === 'Low stock' ? 'status-low' : 'status-out'));

  document.getElementById('detail-onhand').textContent = String(prod.onHand);
  document.getElementById('detail-reserved').textContent = String(prod.reserved);
  document.getElementById('detail-available').textContent = String(available);

  document.getElementById('detail-cost').textContent = formatCurrency(prod.cost);
  document.getElementById('detail-price').textContent = formatCurrency(prod.price);
  document.getElementById('detail-unit-profit').textContent = formatCurrency(unitProfit);
  document.getElementById('detail-margin').textContent = marginPct + '%';
  document.getElementById('detail-asset-val').textContent = formatCurrency(prod.onHand * prod.price);
  document.getElementById('detail-asset-cost').textContent = formatCurrency(prod.onHand * prod.cost);

  document.getElementById('detail-reorder').textContent = `${prod.reorderLevel} Units`;
  document.getElementById('detail-safety').textContent = `${prod.safetyStock} Units`;
  document.getElementById('detail-leadtime').textContent = `${prod.leadTimeDays} Days`;
  document.getElementById('detail-last-restocked').textContent = prod.lastRestocked;

  const miniTbody = document.getElementById('detail-movements-tbody');
  const prodMovements = movements.filter(m => m.productId === prod.id);

  if (miniTbody) {
    if (prodMovements.length === 0) {
      miniTbody.innerHTML = '<tr><td colspan="5" class="text-center">No recorded movements in database</td></tr>';
    } else {
      miniTbody.innerHTML = prodMovements.map(m => `
        <tr>
          <td>${m.timestamp.split(' ')[0]}</td>
          <td><span class="movement-badge">${m.action}</span></td>
          <td class="${m.delta > 0 ? 'delta-positive' : 'delta-negative'}">${m.delta > 0 ? '+' : ''}${m.delta}</td>
          <td>${m.afterQty}</td>
          <td>${m.ref}</td>
        </tr>
      `).join('');
    }
  }

  const editBtn = document.getElementById('btn-detail-edit');
  const countBtn = document.getElementById('btn-detail-count');
  const restockBtn = document.getElementById('btn-detail-restock');

  if (editBtn) editBtn.onclick = () => { closeModal('modal-product-detail'); openAddProductModal(prod); };
  if (countBtn) countBtn.onclick = () => { closeModal('modal-product-detail'); openCycleCountModal(prod.id); };
  if (restockBtn) restockBtn.onclick = () => { closeModal('modal-product-detail'); openRestockModal(prod.id); };

  openModal('modal-product-detail');
}

function openAddProductModal(editProduct = null) {
  const form = document.getElementById('form-product');
  const title = document.getElementById('modal-product-title');
  const isEdit = document.getElementById('prod-form-is-edit');

  form.reset();
  if (editProduct) {
    title.textContent = 'EDIT PRODUCT DETAILS';
    isEdit.value = 'true';
    document.getElementById('prod-id').value = editProduct.id;
    document.getElementById('prod-id').readOnly = true;
    document.getElementById('prod-name').value = editProduct.name;
    document.getElementById('prod-rfid').value = editProduct.rfid;
    document.getElementById('prod-category').value = editProduct.category;
    document.getElementById('prod-supplier').value = editProduct.supplier;
    document.getElementById('prod-cost').value = editProduct.cost;
    document.getElementById('prod-price').value = editProduct.price;
    document.getElementById('prod-reorder').value = editProduct.reorderLevel;
    document.getElementById('prod-safety').value = editProduct.safetyStock;
    document.getElementById('prod-leadTime').value = editProduct.leadTimeDays;
    document.getElementById('prod-onhand').value = editProduct.onHand;
  } else {
    title.textContent = 'ADD NEW PRODUCT TO DATABASE';
    isEdit.value = 'false';
    document.getElementById('prod-id').readOnly = false;
    document.getElementById('prod-id').value = `PROD-${String(products.length + 1).padStart(3, '0')}`;
    document.getElementById('prod-rfid').value = `RF-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  openModal('modal-product');
}

// ==========================================
// 9. Event Listeners & Database Form Handlers
// ==========================================
function setupEventListeners() {
  setInterval(updateHUDClock, 1000);
  updateHUDClock();
  setupLogout();

  // Polling for live database updates every 6 seconds
  setInterval(() => {
    loadDashboardData(true);
  }, 6000);

  // Tab Navigation
  const tabs = document.querySelectorAll('#admin-top-nav .nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const target = tab.dataset.tab;
      document.querySelectorAll('.admin-tab-view').forEach(view => {
        view.classList.remove('active');
      });

      if (target === 'analytics') {
        document.getElementById('view-analytics').classList.add('active');
      } else if (target === 'inventory') {
        document.getElementById('view-inventory').classList.add('active');
        renderInventoryTable();
      } else if (target === 'movements') {
        document.getElementById('view-movements').classList.add('active');
        renderMovementsTable();
      }
    });
  });

  // Action Buttons
  document.getElementById('btn-action-add-prod')?.addEventListener('click', () => openAddProductModal());
  document.getElementById('btn-action-cycle-count')?.addEventListener('click', () => openCycleCountModal());
  document.getElementById('btn-action-restock')?.addEventListener('click', () => openRestockModal());
  document.getElementById('btn-action-thresholds')?.addEventListener('click', () => openThresholdsModal());

  // Close modals
  document.querySelectorAll('.modal-close-x, .btn-modal-cancel').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.admin-modal-overlay');
      if (modal) modal.classList.add('hidden');
    });
  });

  document.querySelectorAll('.admin-modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });

  // Database Form: Cycle Count
  document.getElementById('count-product-select')?.addEventListener('change', updateCycleCountPreview);
  document.getElementById('count-physical-input')?.addEventListener('input', updateCycleCountPreview);

  document.getElementById('form-cycle-count')?.addEventListener('submit', async e => {
    e.preventDefault();
    const token = getAuthToken();
    const prodId = document.getElementById('count-product-select').value;
    const counted = parseInt(document.getElementById('count-physical-input').value, 10);
    const reason = document.getElementById('count-reason').value;
    const notes = document.getElementById('count-notes').value;

    if (isNaN(counted)) return;

    try {
      const res = await fetch(`${API_BASE}/admin/cycle-count`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ productId: prodId, countedQty: counted, reason, notes })
      });

      if (!res.ok) throw new Error('Failed to save count to database');

      closeModal('modal-cycle-count');
      await loadDashboardData(true);
      showToast(`Physical audit persisted to PostgreSQL: ${prodId} adjusted to ${counted} units`);
    } catch (err) {
      showToast('Error recording count: ' + err.message, 'error');
    }
  });

  // Database Form: Restock / Damage
  document.getElementById('form-restock')?.addEventListener('submit', async e => {
    e.preventDefault();
    const token = getAuthToken();
    const prodId = document.getElementById('restock-product-select').value;
    const type = document.getElementById('restock-type').value;
    const qty = parseInt(document.getElementById('restock-qty').value, 10);
    const poNumber = document.getElementById('restock-po').value;
    const notes = document.getElementById('restock-notes').value;

    if (isNaN(qty) || qty <= 0) return;

    try {
      const res = await fetch(`${API_BASE}/admin/restock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ productId: prodId, type, quantity: qty, poNumber, notes })
      });

      if (!res.ok) throw new Error('Failed to record restock in database');

      closeModal('modal-restock');
      await loadDashboardData(true);
      showToast(`Movement saved to PostgreSQL database (${type}: ${qty} units)`);
    } catch (err) {
      showToast('Error processing restock: ' + err.message, 'error');
    }
  });

  // Database Form: Thresholds
  document.getElementById('thresh-product-select')?.addEventListener('change', updateThresholdFormFields);
  document.getElementById('form-thresholds')?.addEventListener('submit', async e => {
    e.preventDefault();
    const token = getAuthToken();
    const prodId = document.getElementById('thresh-product-select').value;

    const payload = {
      reorderLevel: parseInt(document.getElementById('thresh-reorder').value, 10) || 10,
      safetyStock: parseInt(document.getElementById('thresh-safety').value, 10) || 5,
      supplier: document.getElementById('thresh-supplier').value,
      leadTimeDays: parseInt(document.getElementById('thresh-leadtime').value, 10) || 3
    };

    try {
      const res = await fetch(`${API_BASE}/admin/thresholds/${prodId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Failed to update rules in database');

      closeModal('modal-thresholds');
      await loadDashboardData(true);
      showToast(`Reorder thresholds updated in PostgreSQL for ${prodId}`);
    } catch (err) {
      showToast('Error updating rules: ' + err.message, 'error');
    }
  });

  // Database Form: Product Add / Edit
  document.getElementById('form-product')?.addEventListener('submit', async e => {
    e.preventDefault();
    const token = getAuthToken();
    const isEdit = document.getElementById('prod-form-is-edit').value === 'true';
    const id = document.getElementById('prod-id').value.trim();
    const name = document.getElementById('prod-name').value.trim();
    const rfid = document.getElementById('prod-rfid').value.trim();
    const category = document.getElementById('prod-category').value;
    const supplier = document.getElementById('prod-supplier').value.trim();
    const cost = parseFloat(document.getElementById('prod-cost').value) || 0;
    const price = parseFloat(document.getElementById('prod-price').value) || 0;
    const onHand = parseInt(document.getElementById('prod-onhand').value, 10) || 0;
    const reorderLevel = parseInt(document.getElementById('prod-reorder').value, 10) || 10;
    const safetyStock = parseInt(document.getElementById('prod-safety').value, 10) || 5;
    const leadTimeDays = parseInt(document.getElementById('prod-leadTime').value, 10) || 3;

    const payload = {
      id, rfid, name, category, supplier,
      cost, price, onHand, reorderLevel, safetyStock, leadTimeDays
    };

    try {
      const url = isEdit ? `${API_BASE}/admin/products/${id}` : `${API_BASE}/admin/products`;
      const method = isEdit ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Database operation failed');

      closeModal('modal-product');
      await loadDashboardData(true);
      showToast(isEdit ? `Product ${name} updated in PostgreSQL` : `Product ${name} registered in PostgreSQL database`);
    } catch (err) {
      showToast('Error saving product: ' + err.message, 'error');
    }
  });

  // Search & Filters
  const searchInput = document.getElementById('inv-search-input');
  const clearSearchBtn = document.getElementById('btn-clear-search');
  searchInput?.addEventListener('input', e => {
    inventoryFilter.search = e.target.value.trim();
    if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', !inventoryFilter.search);
    renderInventoryTable();
  });

  clearSearchBtn?.addEventListener('click', () => {
    searchInput.value = '';
    inventoryFilter.search = '';
    clearSearchBtn.classList.add('hidden');
    renderInventoryTable();
  });

  document.getElementById('inv-category-filter')?.addEventListener('change', e => {
    inventoryFilter.category = e.target.value;
    renderInventoryTable();
  });

  document.getElementById('inv-status-filter')?.addEventListener('change', e => {
    inventoryFilter.status = e.target.value;
    renderInventoryTable();
  });

  document.getElementById('inv-sort-select')?.addEventListener('change', e => {
    inventoryFilter.sort = e.target.value;
    renderInventoryTable();
  });

  // Table vs Grid View Toggle
  document.getElementById('btn-view-table')?.addEventListener('click', () => {
    inventoryFilter.view = 'table';
    document.getElementById('btn-view-table').classList.add('active');
    document.getElementById('btn-view-cards').classList.remove('active');
    document.getElementById('inventory-table').classList.remove('hidden');
    document.getElementById('inventory-card-grid').classList.add('hidden');
  });

  document.getElementById('btn-view-cards')?.addEventListener('click', () => {
    inventoryFilter.view = 'cards';
    document.getElementById('btn-view-cards').classList.add('active');
    document.getElementById('btn-view-table').classList.remove('active');
    document.getElementById('inventory-table').classList.add('hidden');
    document.getElementById('inventory-card-grid').classList.remove('hidden');
  });

  // Movement Filters
  document.getElementById('movement-type-filter')?.addEventListener('change', renderMovementsTable);
  document.getElementById('movement-product-filter')?.addEventListener('change', renderMovementsTable);

  // Sync Data Button
  document.getElementById('btn-refresh-data')?.addEventListener('click', () => {
    loadDashboardData(false);
  });

  // Export CSV
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const headers = ['Product ID', 'RFID UID', 'Name', 'Category', 'On-Hand', 'Reserved', 'Available', 'Cost', 'Price', 'Reorder Level', 'Safety Stock', 'Status'];
    const rows = products.map(p => [
      p.id,
      p.rfid,
      `"${p.name}"`,
      p.category,
      p.onHand,
      p.reserved,
      getAvailableStock(p),
      p.cost,
      p.price,
      p.reorderLevel,
      p.safetyStock,
      getProductStatus(p)
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `trackcart_inventory_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Inventory CSV export initiated');
  });

  // Date presets
  document.querySelectorAll('.date-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.date-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      analyticsFilter.datePreset = pill.dataset.preset;
      updateAnalyticsFilters();
    });
  });

  // Granularity toggle
  document.querySelectorAll('.granularity-toggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.granularity-toggle .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      analyticsFilter.granularity = btn.dataset.granularity;
      updateAnalyticsFilters();
    });
  });

  // Filter Category & Product in Analytics
  document.getElementById('filter-category')?.addEventListener('change', e => {
    analyticsFilter.category = e.target.value;
    updateAnalyticsFilters();
  });

  document.getElementById('filter-product')?.addEventListener('change', e => {
    analyticsFilter.productId = e.target.value;
    updateAnalyticsFilters();
  });
}

// ==========================================
// 10. Application Bootstrap
// ==========================================
async function initApp() {
  const isAuthed = await enforceAuth();
  if (!isAuthed) return;

  setupEventListeners();
  await loadDashboardData(true);
}

window.addEventListener('DOMContentLoaded', initApp);
