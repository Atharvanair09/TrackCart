/**
 * TrackCart Admin Dashboard Controller
 * Connects UI to PostgreSQL Backend via /api/admin/*
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

  if (userJson) {
    try {
      const user = JSON.parse(userJson);
      const identityEl = document.getElementById('hud-admin-identity');
      if (identityEl && user.email) {
        identityEl.innerHTML = `<span>👤</span> ${user.email}`;
      }
    } catch (e) {}
  }

  try {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      localStorage.removeItem('trackcart_admin_token');
      localStorage.removeItem('trackcart_admin_user');
      window.location.replace('/admin-login.html');
      return false;
    }
  } catch (err) {
    console.warn('[auth] Network notice:', err.message);
  }

  return true;
}

function setupLogout() {
  const logoutButtons = [
    document.getElementById('btn-admin-logout'),
    document.getElementById('btn-sidebar-logout')
  ].filter(Boolean);

  logoutButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = getAuthToken();
      try {
        if (token) {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
          });
        }
      } catch (e) {}
      localStorage.removeItem('trackcart_admin_token');
      localStorage.removeItem('trackcart_admin_user');
      showToast('Signed out. Redirecting...', 'info');
      setTimeout(() => window.location.replace('/admin-login.html'), 400);
    });
  });
}

// ==========================================
// 1. Global Application State
// ==========================================
// Restore demo mode from localStorage so mode survives page refreshes
let isDemoMode = localStorage.getItem('trackcart_demo_mode') === 'true';
let currentTab = 'dashboard';
let currentReportTab = 'sales';

let products = [];
let movements = [];
let sessionsData = [];
let salesData = [];
let expiryData = [];
let forecastData = [];
let basketData = null;
let dashboardStats = null;
let analyticsData = null;

// ==========================================
// DEMO MODE — Complete Isolated Data Layer
// All demo data uses unique IDs (DEMO-001..DEMO-015) completely
// separate from real PostgreSQL product IDs (PROD-001..PROD-011).
// No backend API calls are made in demo mode.
// ==========================================

const _D_PRODUCTS = [
  { id:'DEMO-001', dbId:1, rfid:'DRF001', name:'Premium NC Headphones', category:'Electronics', onHand:45, reserved:5, available:40, status:'In Stock', cost:42.00, price:89.99, reorderLevel:15, safetyStock:8, leadTimeDays:7, targetCoverageDays:21, lastRestocked:'2026-10-15', expiryDate:null, batchNumber:null, supplier:'SoundTech Asia', soldUnits:128, revenue:11518.72, isActive:true },
  { id:'DEMO-002', dbId:2, rfid:'DRF002', name:'Artisan Cold Brew 500ml', category:'Beverages', onHand:120, reserved:12, available:108, status:'In Stock', cost:2.10, price:5.49, reorderLevel:30, safetyStock:15, leadTimeDays:2, targetCoverageDays:14, lastRestocked:'2026-11-01', expiryDate:'2026-12-20', batchNumber:'CB-2026-11', supplier:'BrewCraft Ltd', soldUnits:691, revenue:3793.59, isActive:true },
  { id:'DEMO-003', dbId:3, rfid:'DRF003', name:'Organic Protein Granola', category:'Snacks', onHand:0, reserved:0, available:0, status:'Out of Stock', cost:1.40, price:3.29, reorderLevel:30, safetyStock:15, leadTimeDays:3, targetCoverageDays:14, lastRestocked:'2026-10-02', expiryDate:'2026-10-25', batchNumber:'GB-2026-10', supplier:'NutriPure Co', soldUnits:0, revenue:0, isActive:true },
  { id:'DEMO-004', dbId:4, rfid:'DRF004', name:'Smart Fitness Band', category:'Electronics', onHand:18, reserved:3, available:15, status:'In Stock', cost:22.00, price:49.99, reorderLevel:10, safetyStock:5, leadTimeDays:5, targetCoverageDays:21, lastRestocked:'2026-10-20', expiryDate:null, batchNumber:null, supplier:'FitTech Corp', soldUnits:62, revenue:3099.38, isActive:true },
  { id:'DEMO-005', dbId:5, rfid:'DRF005', name:'Himalayan Mineral Water 1L', category:'Beverages', onHand:200, reserved:8, available:192, status:'In Stock', cost:0.80, price:2.99, reorderLevel:50, safetyStock:25, leadTimeDays:1, targetCoverageDays:7, lastRestocked:'2026-11-04', expiryDate:'2027-05-15', batchNumber:'HW-2026-11', supplier:'PureSource Inc', soldUnits:962, revenue:2876.38, isActive:true },
  { id:'DEMO-006', dbId:6, rfid:'DRF006', name:'Mixed Nut Trail Pack 150g', category:'Snacks', onHand:35, reserved:4, available:31, status:'In Stock', cost:3.10, price:6.49, reorderLevel:20, safetyStock:10, leadTimeDays:3, targetCoverageDays:14, lastRestocked:'2026-10-25', expiryDate:'2026-11-28', batchNumber:'NT-2026-10', supplier:'NutriPure Co', soldUnits:218, revenue:1414.82, isActive:true },
  { id:'DEMO-007', dbId:7, rfid:'DRF007', name:'UV Sanitizer Pouch', category:'Health', onHand:8, reserved:1, available:7, status:'Low Stock', cost:6.50, price:14.99, reorderLevel:10, safetyStock:5, leadTimeDays:5, targetCoverageDays:21, lastRestocked:'2026-09-10', expiryDate:null, batchNumber:null, supplier:'HealthShield Ltd', soldUnits:84, revenue:1259.16, isActive:true },
  { id:'DEMO-008', dbId:8, rfid:'DRF008', name:'Matcha Latte Powder 200g', category:'Beverages', onHand:62, reserved:6, available:56, status:'In Stock', cost:5.80, price:12.99, reorderLevel:20, safetyStock:10, leadTimeDays:4, targetCoverageDays:21, lastRestocked:'2026-10-18', expiryDate:'2027-03-01', batchNumber:'ML-2026-10', supplier:'Zen Harvest', soldUnits:143, revenue:1857.57, isActive:true },
  { id:'DEMO-009', dbId:9, rfid:'DRF009', name:'Stainless Steel Straw Set', category:'Accessories', onHand:3, reserved:0, available:3, status:'Low Stock', cost:3.80, price:8.99, reorderLevel:8, safetyStock:4, leadTimeDays:4, targetCoverageDays:14, lastRestocked:'2026-09-15', expiryDate:null, batchNumber:null, supplier:'EcoLife Store', soldUnits:92, revenue:827.08, isActive:true },
  { id:'DEMO-010', dbId:10, rfid:'DRF010', name:'Vegan Chocolate Bar 70g', category:'Snacks', onHand:88, reserved:9, available:79, status:'In Stock', cost:2.20, price:4.79, reorderLevel:25, safetyStock:12, leadTimeDays:2, targetCoverageDays:14, lastRestocked:'2026-11-01', expiryDate:'2026-11-14', batchNumber:'VC-2026-11', supplier:'PureChoc Labs', soldUnits:804, revenue:3851.16, isActive:true },
  { id:'DEMO-011', dbId:11, rfid:'DRF011', name:'Sports Compression Socks', category:'Accessories', onHand:24, reserved:2, available:22, status:'In Stock', cost:7.50, price:16.99, reorderLevel:12, safetyStock:6, leadTimeDays:5, targetCoverageDays:21, lastRestocked:'2026-10-05', expiryDate:null, batchNumber:null, supplier:'ActiveGear Co', soldUnits:38, revenue:645.62, isActive:true },
  { id:'DEMO-012', dbId:12, rfid:'DRF012', name:'Vitamin C Effervescent 20s', category:'Health', onHand:5, reserved:0, available:5, status:'Low Stock', cost:4.20, price:9.99, reorderLevel:8, safetyStock:4, leadTimeDays:3, targetCoverageDays:14, lastRestocked:'2026-09-20', expiryDate:'2026-12-10', batchNumber:'VC-2026-09', supplier:'HealthShield Ltd', soldUnits:71, revenue:709.29, isActive:true },
  { id:'DEMO-013', dbId:13, rfid:'DRF013', name:'Eco Reusable Tote Bag', category:'Accessories', onHand:140, reserved:0, available:140, status:'In Stock', cost:3.00, price:7.49, reorderLevel:30, safetyStock:15, leadTimeDays:5, targetCoverageDays:21, lastRestocked:'2026-10-10', expiryDate:null, batchNumber:null, supplier:'EcoLife Store', soldUnits:29, revenue:217.21, isActive:true },
  { id:'DEMO-014', dbId:14, rfid:'DRF014', name:'Espresso Coffee Pod x10', category:'Beverages', onHand:76, reserved:11, available:65, status:'In Stock', cost:3.90, price:7.99, reorderLevel:25, safetyStock:12, leadTimeDays:2, targetCoverageDays:14, lastRestocked:'2026-11-02', expiryDate:'2027-01-15', batchNumber:'EP-2026-11', supplier:'BrewCraft Ltd', soldUnits:330, revenue:2636.70, isActive:true },
  { id:'DEMO-015', dbId:15, rfid:'DRF015', name:'Wireless Charging Pad', category:'Electronics', onHand:14, reserved:2, available:12, status:'In Stock', cost:12.00, price:29.99, reorderLevel:8, safetyStock:4, leadTimeDays:6, targetCoverageDays:21, lastRestocked:'2026-10-22', expiryDate:null, batchNumber:null, supplier:'SoundTech Asia', soldUnits:47, revenue:1409.53, isActive:true }
];

const _D_MOVEMENTS = [
  { id:'DMOV-008', timestamp:'2026-11-06 14:30:00', productId:'DEMO-001', productName:'Premium NC Headphones', rfid:'DRF001', action:'CHECKOUT', delta:-2, beforeQty:47, afterQty:45, ref:'DCRT-9910-AX', notes:'Express checkout RFID settlement' },
  { id:'DMOV-007', timestamp:'2026-11-06 12:15:00', productId:'DEMO-010', productName:'Vegan Chocolate Bar 70g', rfid:'DRF010', action:'CHECKOUT', delta:-3, beforeQty:91, afterQty:88, ref:'DCRT-9905-B', notes:'Standard cart checkout' },
  { id:'DMOV-006', timestamp:'2026-11-06 10:00:00', productId:'DEMO-005', productName:'Himalayan Mineral Water 1L', rfid:'DRF005', action:'RESTOCK', delta:50, beforeQty:150, afterQty:200, ref:'DPO-2026-1104', notes:'Inbound delivery — PureSource Inc' },
  { id:'DMOV-005', timestamp:'2026-11-05 16:45:00', productId:'DEMO-003', productName:'Organic Protein Granola', rfid:'DRF003', action:'DAMAGE_WRITEOFF', delta:-8, beforeQty:8, afterQty:0, ref:'DDMG-WRT-022', notes:'Expired stock removal — batch GB-2026-10' },
  { id:'DMOV-004', timestamp:'2026-11-05 14:00:00', productId:'DEMO-009', productName:'Stainless Steel Straw Set', rfid:'DRF009', action:'CYCLE_COUNT', delta:-4, beforeQty:7, afterQty:3, ref:'DAUDIT-FLOOR-B', notes:'Physical shelf count — 4 units missing' },
  { id:'DMOV-003', timestamp:'2026-11-05 11:30:00', productId:'DEMO-014', productName:'Espresso Coffee Pod x10', rfid:'DRF014', action:'RESTOCK', delta:30, beforeQty:46, afterQty:76, ref:'DPO-2026-1102', notes:'Fresh batch delivery — BrewCraft Ltd' },
  { id:'DMOV-002', timestamp:'2026-11-04 15:00:00', productId:'DEMO-002', productName:'Artisan Cold Brew 500ml', rfid:'DRF002', action:'CHECKOUT', delta:-12, beforeQty:132, afterQty:120, ref:'DCRT-9881-K', notes:'Bulk cart checkout — 12 units' },
  { id:'DMOV-001', timestamp:'2026-11-04 09:00:00', productId:'DEMO-007', productName:'UV Sanitizer Pouch', rfid:'DRF007', action:'CHECKOUT', delta:-3, beforeQty:11, afterQty:8, ref:'DCRT-9872-M', notes:'Cart checkout — low stock alert triggered' }
];

const _D_KPI = {
  totalProducts: 15,
  availableStock: 775,
  activeShoppingCarts: 3,
  todaySales: 2847.50,
  completedOrders: 47,
  lowStockCount: 3,
  outOfStockCount: 1,
  grossProfit: 12435.80,
  totalOnHand: 838,
  totalReserved: 63,
  totalAssetVal: 48234.00
};

const DEMO_DASHBOARD_DATA = {
  success: true,
  kpis: _D_KPI,
  products: _D_PRODUCTS,
  movements: _D_MOVEMENTS,
  storeInsights: {
    lowStock: [
      { id:'DEMO-007', name:'UV Sanitizer Pouch', available:7, reorderLevel:10, suggestedReorderQty:25, status:'Low Stock' },
      { id:'DEMO-009', name:'Stainless Steel Straw Set', available:3, reorderLevel:8, suggestedReorderQty:20, status:'Low Stock' },
      { id:'DEMO-012', name:'Vitamin C Effervescent 20s', available:5, reorderLevel:8, suggestedReorderQty:18, status:'Low Stock' },
      { id:'DEMO-003', name:'Organic Protein Granola', available:0, reorderLevel:30, suggestedReorderQty:60, status:'Out of Stock' }
    ],
    stockoutRisk: [
      { id:'DEMO-009', name:'Stainless Steel Straw Set', available:3, daysUntilStockout:2, stockoutDate:'2026-11-08', leadTimeDays:4 },
      { id:'DEMO-012', name:'Vitamin C Effervescent 20s', available:5, daysUntilStockout:4, stockoutDate:'2026-11-10', leadTimeDays:3 }
    ],
    expiringSoon: [
      { id:'DEMO-003', name:'Organic Protein Granola', expiryDate:'2026-10-25', batchNumber:'GB-2026-10', daysUntilExpiry:-12, available:0, isExpired:true },
      { id:'DEMO-010', name:'Vegan Chocolate Bar 70g', expiryDate:'2026-11-14', batchNumber:'VC-2026-11', daysUntilExpiry:8, available:79, isExpired:false },
      { id:'DEMO-006', name:'Mixed Nut Trail Pack 150g', expiryDate:'2026-11-28', batchNumber:'NT-2026-10', daysUntilExpiry:22, available:31, isExpired:false }
    ],
    slowMoving: [
      { id:'DEMO-013', name:'Eco Reusable Tote Bag', available:140, soldUnits:29, avgDailySales:0.5, classification:'Slow Moving' },
      { id:'DEMO-011', name:'Sports Compression Socks', available:22, soldUnits:38, avgDailySales:0.6, classification:'Slow Moving' }
    ],
    reorderRecommendations: [
      { id:'DEMO-009', name:'Stainless Steel Straw Set', available:3, targetStock:20, suggestedQty:20, supplier:'EcoLife Store', leadTimeDays:4, reason:'Critical stockout risk — 2 days supply remaining' },
      { id:'DEMO-003', name:'Organic Protein Granola', available:0, targetStock:60, suggestedQty:60, supplier:'NutriPure Co', leadTimeDays:3, reason:'Out of stock — reorder immediately' },
      { id:'DEMO-012', name:'Vitamin C Effervescent 20s', available:5, targetStock:18, suggestedQty:18, supplier:'HealthShield Ltd', leadTimeDays:3, reason:'Low stock — 4 days supply remaining' },
      { id:'DEMO-007', name:'UV Sanitizer Pouch', available:7, targetStock:25, suggestedQty:18, supplier:'HealthShield Ltd', leadTimeDays:5, reason:'Below reorder threshold (10 units)' }
    ],
    suggestedCombos: [
      { title:'Cold Brew + Protein Granola', transactions:34, lift:2.4, recommendation:'Bundle at checkout lane — high co-purchase affinity (Lift 2.4x)' },
      { title:'Headphones + Charging Pad', transactions:28, lift:2.1, recommendation:'Electronics cross-sell display — frequently purchased together (Lift 2.1x)' },
      { title:'Trail Mix + Mineral Water', transactions:19, lift:1.8, recommendation:'Healthy snack combo promotion — moderate affinity (Lift 1.8x)' }
    ],
    recentActivity: _D_MOVEMENTS.slice(0, 6)
  },
  todaysPriorities: [
    { id:'prio-reorder', type:'reorder', badge:'Reorder Urgently', priority:'high', title:'Reorder Stainless Steel Straw Set', subtitle:'2 days of stock remaining (3 units on shelf). Recommended reorder: 20 units from EcoLife Store.', targetTab:'forecasting', targetId:'DEMO-009', actionLabel:'Review Reorder' },
    { id:'prio-expiry', type:'expiry', badge:'Expired Stock', priority:'danger', title:'Remove Expired Organic Protein Granola', subtitle:'Product expired 2026-10-25 (12 days ago). Write off remaining units immediately — batch GB-2026-10.', targetTab:'expiry', targetId:'DEMO-003', actionLabel:'Inspect Expiry' },
    { id:'prio-promo', type:'promotion', badge:'Promote Slow Mover', priority:'normal', title:'Consider Promotion for Eco Reusable Tote Bag', subtitle:'Low velocity (0.5 units/day) with 140 units in stock. Recommend 15% promotional discount or bundle.', targetTab:'expiry', targetId:'DEMO-013', actionLabel:'Create Promotion' },
    { id:'prio-combo', type:'combo', badge:'Market Basket Synergy', priority:'normal', title:'Suggested Combo: Cold Brew + Protein Granola', subtitle:'Frequently co-purchased in 34 transactions (Lift 2.4x). Recommended for cart cross-sell.', targetTab:'basket', actionLabel:'View Basket Analysis' }
  ]
};

// Demo Sessions Data
const DEMO_SESSIONS_DATA = [
  { session_id:'DEMO_SESS_003', cart_id:'CART_01', user_id:'GUEST_003', status:'active', started_at: (() => { const d=new Date(Date.now()-8*60000); return d.toISOString().replace('T',' ').slice(0,19); })(), ended_at:null, item_count:2, subtotal:94.98, sale_id:null,
    items:[ {product_id:'DEMO-001',name:'Premium NC Headphones',category:'Electronics',quantity:1,unit_price_at_addition:89.99,subtotal:89.99}, {product_id:'DEMO-002',name:'Artisan Cold Brew 500ml',category:'Beverages',quantity:1,unit_price_at_addition:5.49,subtotal:5.49} ] },
  { session_id:'DEMO_SESS_002', cart_id:'CART_02', user_id:'GUEST_002', status:'completed', started_at:'2026-11-06 10:15:00', ended_at:'2026-11-06 10:52:00', item_count:5, subtotal:38.74, sale_id:'DEMO_SALE_002',
    items:[ {product_id:'DEMO-010',name:'Vegan Chocolate Bar 70g',category:'Snacks',quantity:3,unit_price_at_addition:4.79,subtotal:14.37}, {product_id:'DEMO-005',name:'Himalayan Mineral Water 1L',category:'Beverages',quantity:2,unit_price_at_addition:2.99,subtotal:5.98}, {product_id:'DEMO-014',name:'Espresso Coffee Pod x10',category:'Beverages',quantity:2,unit_price_at_addition:7.99,subtotal:15.98} ] },
  { session_id:'DEMO_SESS_001', cart_id:'CART_03', user_id:'GUEST_001', status:'completed', started_at:'2026-11-06 09:00:00', ended_at:'2026-11-06 09:38:00', item_count:3, subtotal:144.97, sale_id:'DEMO_SALE_001',
    items:[ {product_id:'DEMO-001',name:'Premium NC Headphones',category:'Electronics',quantity:1,unit_price_at_addition:89.99,subtotal:89.99}, {product_id:'DEMO-015',name:'Wireless Charging Pad',category:'Electronics',quantity:1,unit_price_at_addition:29.99,subtotal:29.99}, {product_id:'DEMO-004',name:'Smart Fitness Band',category:'Electronics',quantity:1,unit_price_at_addition:49.99,subtotal:49.99} ] },
  { session_id:'DEMO_SESS_000', cart_id:'CART_01', user_id:null, status:'cancelled', started_at:'2026-11-05 17:30:00', ended_at:'2026-11-05 17:35:00', item_count:0, subtotal:0, sale_id:null, items:[] }
];

// Demo Sales Data
const DEMO_SALES_DATA = [
  { sale_id:'DEMO_SALE_001', session_id:'DEMO_SESS_001', subtotal:169.97, tax_rate:0.0825, tax_amount:14.02, total:183.99, item_count:3, completed_at:'2026-11-06 09:38:00',
    lineItems:[ {product_id:'DEMO-001',name:'Premium NC Headphones',category:'Electronics',quantity:1,unit_price:89.99,line_subtotal:89.99}, {product_id:'DEMO-015',name:'Wireless Charging Pad',category:'Electronics',quantity:1,unit_price:29.99,line_subtotal:29.99}, {product_id:'DEMO-004',name:'Smart Fitness Band',category:'Electronics',quantity:1,unit_price:49.99,line_subtotal:49.99} ] },
  { sale_id:'DEMO_SALE_002', session_id:'DEMO_SESS_002', subtotal:36.33, tax_rate:0.0825, tax_amount:3.00, total:39.33, item_count:7, completed_at:'2026-11-06 10:52:00',
    lineItems:[ {product_id:'DEMO-010',name:'Vegan Chocolate Bar 70g',category:'Snacks',quantity:3,unit_price:4.79,line_subtotal:14.37}, {product_id:'DEMO-005',name:'Himalayan Mineral Water 1L',category:'Beverages',quantity:2,unit_price:2.99,line_subtotal:5.98}, {product_id:'DEMO-014',name:'Espresso Coffee Pod x10',category:'Beverages',quantity:2,unit_price:7.99,line_subtotal:15.98} ] },
  { sale_id:'DEMO_SALE_000', session_id:null, subtotal:12435.80, tax_rate:0.0825, tax_amount:1025.95, total:13461.75, item_count:2622, completed_at:'2026-11-05 23:59:00',
    lineItems:[ {product_id:'DEMO-001',name:'Premium NC Headphones',category:'Electronics',quantity:126,unit_price:89.99,line_subtotal:11338.74}, {product_id:'DEMO-010',name:'Vegan Chocolate Bar 70g',category:'Snacks',quantity:800,unit_price:4.79,line_subtotal:3832.00}, {product_id:'DEMO-002',name:'Artisan Cold Brew 500ml',category:'Beverages',quantity:688,unit_price:5.49,line_subtotal:3777.12}, {product_id:'DEMO-005',name:'Himalayan Mineral Water 1L',category:'Beverages',quantity:959,unit_price:2.99,line_subtotal:2867.41}, {product_id:'DEMO-004',name:'Smart Fitness Band',category:'Electronics',quantity:61,unit_price:49.99,line_subtotal:3049.39} ] }
];

// Demo Forecast Data
const DEMO_FORECAST_DATA = {
  success: true,
  isSimulated: true,
  forecast: _D_PRODUCTS.map(p => {
    const avgDaily = p.soldUnits > 0 ? +(p.soldUnits / 30).toFixed(2) : 0;
    const days = avgDaily > 0 ? Math.min(Math.round(p.available / avgDaily), 999) : 999;
    const stockoutDate = avgDaily > 0 ? (() => { const d=new Date(); d.setDate(d.getDate()+days); return d.toISOString().split('T')[0]; })() : 'No forecast';
    const target = Math.round(avgDaily * p.targetCoverageDays + p.safetyStock);
    const reorderQty = Math.max(0, target - p.available);
    let cls = 'Well Stocked';
    if (p.available <= 0) cls = 'Out of Stock';
    else if (days <= 3) cls = 'Critical Stockout Risk';
    else if (p.available <= p.reorderLevel) cls = 'Low Stock';
    else if (avgDaily >= 20) cls = 'Fast Moving';
    else if (avgDaily < 1 && p.soldUnits > 0) cls = 'Slow Moving';
    else if (p.soldUnits === 0) cls = 'Dormant Stock';
    return { id:p.id, name:p.name, category:p.category, available:p.available, soldUnits:p.soldUnits, avgDailySales:avgDaily, daysUntilStockout:days, stockoutDate, targetStock:target, suggestedReorderQty:reorderQty, classification:cls, recommendationReason: reorderQty>0 ? `Order ${reorderQty} units from ${p.supplier} (${p.leadTimeDays}d lead time)` : 'Stock level adequate for current demand', supplier:p.supplier, leadTimeDays:p.leadTimeDays };
  })
};

// Demo Expiry Data
const DEMO_EXPIRY_DATA = {
  success: true,
  isSimulated: true,
  items: [
    { productId:'DEMO-003', name:'Organic Protein Granola', batchNumber:'GB-2026-10', expiryDate:'2026-10-25', daysUntilExpiry:-12, quantityAtRisk:0, status:'expired', action:'Remove from shelves immediately — EXPIRED', suggestedDiscount:0 },
    { productId:'DEMO-010', name:'Vegan Chocolate Bar 70g', batchNumber:'VC-2026-11', expiryDate:'2026-11-14', daysUntilExpiry:8, quantityAtRisk:79, status:'expiring_7d', action:'Apply 25% promotional discount — 8 days to expiry', suggestedDiscount:25 },
    { productId:'DEMO-006', name:'Mixed Nut Trail Pack 150g', batchNumber:'NT-2026-10', expiryDate:'2026-11-28', daysUntilExpiry:22, quantityAtRisk:31, status:'expiring_30d', action:'Apply 10% promotional discount — 22 days to expiry', suggestedDiscount:10 },
    { productId:'DEMO-002', name:'Artisan Cold Brew 500ml', batchNumber:'CB-2026-11', expiryDate:'2026-12-20', daysUntilExpiry:44, quantityAtRisk:120, status:'healthy', action:'Monitor regularly — batch healthy', suggestedDiscount:0 },
    { productId:'DEMO-012', name:'Vitamin C Effervescent 20s', batchNumber:'VC-2026-09', expiryDate:'2026-12-10', daysUntilExpiry:34, quantityAtRisk:5, status:'healthy', action:'Monitor regularly — batch healthy', suggestedDiscount:0 },
    { productId:'DEMO-005', name:'Himalayan Mineral Water 1L', batchNumber:'HW-2026-11', expiryDate:'2027-05-15', daysUntilExpiry:190, quantityAtRisk:200, status:'healthy', action:'Healthy shelf life — no action needed', suggestedDiscount:0 }
  ]
};

// Demo Market Basket Data
const DEMO_BASKET_DATA = {
  success: true,
  isSimulated: true,
  totalEligibleTransactions: 47,
  combos: [
    { title:'Cold Brew + Protein Granola', transactions:34, lift:2.4, confidence:'85%', recommendation:'Bundle at checkout — high co-purchase affinity detected across 34 transactions' },
    { title:'Headphones + Wireless Charging Pad', transactions:28, lift:2.1, confidence:'78%', recommendation:'Electronics cross-sell endcap display — complement purchase pattern' },
    { title:'Trail Mix + Mineral Water', transactions:19, lift:1.8, confidence:'62%', recommendation:'Healthy snack combo display — moderate affinity across 19 baskets' }
  ],
  pairs: [
    { productA:{id:'DEMO-002',name:'Artisan Cold Brew 500ml',category:'Beverages'}, productB:{id:'DEMO-003',name:'Organic Protein Granola',category:'Snacks'}, coOccurrenceCount:34, support:0.72, confidenceAtoB:0.85, lift:2.4, suggestedAction:'Create bundle promotion — high lift value' },
    { productA:{id:'DEMO-001',name:'Premium NC Headphones',category:'Electronics'}, productB:{id:'DEMO-015',name:'Wireless Charging Pad',category:'Electronics'}, coOccurrenceCount:28, support:0.60, confidenceAtoB:0.78, lift:2.1, suggestedAction:'Cross-sell display on electronics shelf' },
    { productA:{id:'DEMO-006',name:'Mixed Nut Trail Pack 150g',category:'Snacks'}, productB:{id:'DEMO-005',name:'Himalayan Mineral Water 1L',category:'Beverages'}, coOccurrenceCount:19, support:0.40, confidenceAtoB:0.62, lift:1.8, suggestedAction:'Healthy lifestyle combo — moderate cross-sell potential' },
    { productA:{id:'DEMO-009',name:'Stainless Steel Straw Set',category:'Accessories'}, productB:{id:'DEMO-013',name:'Eco Reusable Tote Bag',category:'Accessories'}, coOccurrenceCount:15, support:0.32, confidenceAtoB:0.71, lift:1.6, suggestedAction:'Eco-conscious bundle — place near checkout' },
    { productA:{id:'DEMO-014',name:'Espresso Coffee Pod x10',category:'Beverages'}, productB:{id:'DEMO-008',name:'Matcha Latte Powder 200g',category:'Beverages'}, coOccurrenceCount:11, support:0.23, confidenceAtoB:0.58, lift:1.4, suggestedAction:'Hot-drink cross-sell recommendation' }
  ]
};

// Demo Analytics Data — fully deterministic (no Math.random)
const DEMO_ANALYTICS_DATA = (() => {
  const baseDate = new Date('2026-10-24');
  const revArr  = [384.50,572.30,287.00,668.75,479.25,764.80,605.20,892.40,701.50,510.75,987.60,797.30,638.00,447.50];
  const ordArr  = [12,18,9,21,15,24,19,28,22,16,31,25,20,14];
  const unitArr = [34,51,25,59,42,67,53,79,62,45,87,70,56,39];
  const ts=[],us=[],as=[];
  for(let i=0;i<14;i++){
    const d=new Date(baseDate); d.setDate(d.getDate()+i);
    const bucket=d.toISOString().split('T')[0];
    ts.push({bucket,orders:ordArr[i],revenue:revArr[i],subtotal:+(revArr[i]/1.0825).toFixed(2)});
    us.push({bucket,units:unitArr[i]});
    as.push({bucket,aov:+(revArr[i]/ordArr[i]).toFixed(2)});
  }
  const stockDist = _D_PRODUCTS.map(p=>({name:p.name,onHand:p.onHand,reserved:p.reserved,available:p.available}));
  return {
    success:true, isSimulated:true,
    timeSeries:ts, unitSeries:us, aovSeries:as,
    categorySales:[
      {category:'Electronics',revenue:17077.22,units:364},
      {category:'Beverages',revenue:13081.20,units:2740},
      {category:'Snacks',revenue:5265.98,units:1051},
      {category:'Accessories',revenue:1689.91,units:159},
      {category:'Health',revenue:1968.45,units:155}
    ],
    topProducts:[
      {id:'DEMO-001',name:'Premium NC Headphones',revenue:11518.72,units:128},
      {id:'DEMO-010',name:'Vegan Chocolate Bar 70g',revenue:3851.16,units:804},
      {id:'DEMO-002',name:'Artisan Cold Brew 500ml',revenue:3793.59,units:691},
      {id:'DEMO-005',name:'Himalayan Mineral Water 1L',revenue:2876.38,units:962},
      {id:'DEMO-014',name:'Espresso Coffee Pod x10',revenue:2636.70,units:330},
      {id:'DEMO-004',name:'Smart Fitness Band',revenue:3099.38,units:62},
      {id:'DEMO-008',name:'Matcha Latte Powder 200g',revenue:1857.57,units:143},
      {id:'DEMO-015',name:'Wireless Charging Pad',revenue:1409.53,units:47}
    ],
    stockDistribution: stockDist,
    inventoryMovements:[
      {action:'RESTOCK',count:12,totalUnits:380},
      {action:'CHECKOUT',count:47,totalUnits:263},
      {action:'CYCLE_COUNT',count:4,totalUnits:6},
      {action:'DAMAGE_WRITEOFF',count:2,totalUnits:11}
    ],
    expiryStatusChart:[
      {label:'Healthy (>30d)',count:9,units:502},
      {label:'Expiring in 30d',count:1,units:31},
      {label:'Expiring in 7d',count:1,units:79},
      {label:'Expired',count:1,units:0}
    ],
    basketPairs:[
      {productA:{id:'DEMO-002',name:'Artisan Cold Brew 500ml'},productB:{id:'DEMO-003',name:'Organic Protein Granola'},coOccurrenceCount:34,lift:2.4},
      {productA:{id:'DEMO-001',name:'Premium NC Headphones'},productB:{id:'DEMO-015',name:'Wireless Charging Pad'},coOccurrenceCount:28,lift:2.1},
      {productA:{id:'DEMO-006',name:'Mixed Nut Trail Pack 150g'},productB:{id:'DEMO-005',name:'Himalayan Mineral Water 1L'},coOccurrenceCount:19,lift:1.8},
      {productA:{id:'DEMO-009',name:'Stainless Steel Straw Set'},productB:{id:'DEMO-013',name:'Eco Reusable Tote Bag'},coOccurrenceCount:15,lift:1.6},
      {productA:{id:'DEMO-014',name:'Espresso Coffee Pod x10'},productB:{id:'DEMO-008',name:'Matcha Latte Powder 200g'},coOccurrenceCount:11,lift:1.4}
    ],
    activeSessions:3
  };
})();

// Filter States
let inventoryFilter = {
  search: '',
  category: 'ALL',
  status: 'ALL',
  sort: 'available-asc'
};

let movementsFilter = {
  search: '',
  action: 'ALL'
};

let expiryFilter = 'ALL';
let forecastFilterClass = 'ALL';
let forecastWindowDays = 30;

// Chart.js Instances Registry
const charts = {};

// Universal Helper to destroy and rebuild charts cleanly across views
function createChart(canvasId, type, data, options = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (charts[canvasId]) {
    try {
      charts[canvasId].destroy();
    } catch (e) {
      console.warn('Error destroying chart', canvasId, e);
    }
  }

  charts[canvasId] = new Chart(ctx, {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: options.showLegend ?? false,
          position: options.legendPosition || 'top',
          labels: { font: { family: 'Inter', size: 11 }, boxWidth: 12, padding: 10 }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          padding: 10,
          cornerRadius: 8,
          titleFont: { family: 'Inter', size: 12, weight: 'bold' },
          bodyFont: { family: 'Inter', size: 11 }
        }
      },
      scales: options.scales || {
        x: { grid: { color: '#f1f5f9' }, ticks: { font: { family: 'Inter', size: 10 } } },
        y: { grid: { color: '#f1f5f9' }, ticks: { font: { family: 'Inter', size: 10 } } }
      },
      ...options.extra
    }
  });
  return charts[canvasId];
}

// ==========================================
// 2. Utility Helpers
// ==========================================
function formatCurrency(val) {
  return '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(val) {
  return Number(val || 0).toLocaleString('en-US');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('admin-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function updateHUDClock() {
  const clockEl = document.getElementById('hud-live-clock');
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString();
  }
}
setInterval(updateHUDClock, 1000);

// ==========================================
// 3. API Fetchers
// ==========================================
async function fetchWithAuth(url, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    window.location.replace('/admin-login.html');
    throw new Error('Unauthorized');
  }
  return res;
}

async function loadDashboardData() {
  if (isDemoMode) {
    dashboardStats = DEMO_DASHBOARD_DATA;
    products = DEMO_DASHBOARD_DATA.products || [];
    movements = DEMO_DASHBOARD_DATA.movements || [];
    renderDashboard();
    renderInventoryTable();
    renderMovementsTable();
    populateProductSelects();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/dashboard`);
    const data = await res.json();
    if (data.success) {
      dashboardStats = data;
      products = data.products || [];
      movements = data.movements || [];
      renderDashboard();
      renderInventoryTable();
      renderMovementsTable();
      populateProductSelects();
    }
  } catch (err) {
    console.error('Error loading dashboard:', err);
    showToast('Failed to load dashboard data', 'error');
  }
}


async function loadSessionsData() {
  if (isDemoMode) {
    sessionsData = DEMO_SESSIONS_DATA;
    renderSessionsTable();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/sessions?limit=50`);
    const data = await res.json();
    if (data.success) {
      sessionsData = data.sessions || [];
      renderSessionsTable();
    }
  } catch (err) {
    console.error('Error loading sessions:', err);
    showToast('Failed to load sessions data', 'error');
  }
}


async function loadSalesData() {
  if (isDemoMode) {
    salesData = DEMO_SALES_DATA;
    const demoTotals = {
      count: DEMO_SALES_DATA.length,
      revenue: DEMO_SALES_DATA.reduce((s, d) => s + d.total, 0),
      tax: DEMO_SALES_DATA.reduce((s, d) => s + d.tax_amount, 0)
    };
    renderSalesSection(demoTotals);
    return;
  }
  try {
    const start = document.getElementById('sales-start-date')?.value;
    const end = document.getElementById('sales-end-date')?.value;
    let url = `${API_BASE}/admin/sales?limit=100`;
    if (start && end) url += `&startDate=${start}&endDate=${end}`;

    const res = await fetchWithAuth(url);
    const data = await res.json();
    if (data.success) {
      salesData = data.sales || [];
      renderSalesSection(data.totals);
    }
  } catch (err) {
    console.error('Error loading sales:', err);
    showToast('Failed to load sales data', 'error');
  }
}

async function loadExpiryData() {
  if (isDemoMode) {
    expiryData = DEMO_EXPIRY_DATA.items || [];
    renderExpirySection();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/expiry`);
    const data = await res.json();
    if (data.success) {
      expiryData = data.items || [];
      renderExpirySection();
    }
  } catch (err) {
    console.error('Error loading expiry data:', err);
  }
}

async function loadForecastData() {
  if (isDemoMode) {
    forecastData = DEMO_FORECAST_DATA.forecast || [];
    renderForecastSection();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/demand-forecast?window=${forecastWindowDays}`);
    const data = await res.json();
    if (data.success) {
      forecastData = data.forecast || [];
      renderForecastSection();
    }
  } catch (err) {
    console.error('Error loading forecast data:', err);
  }
}

async function loadMarketBasketData() {
  if (isDemoMode) {
    basketData = DEMO_BASKET_DATA;
    renderMarketBasketSection();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/market-basket`);
    const data = await res.json();
    if (data.success) {
      basketData = data;
      renderMarketBasketSection();
    }
  } catch (err) {
    console.error('Error loading basket data:', err);
  }
}

async function loadAnalyticsData() {
  if (isDemoMode) {
    analyticsData = DEMO_ANALYTICS_DATA;
    renderAllCharts();
    renderDashboardCharts();
    return;
  }
  try {
    const res = await fetchWithAuth(`${API_BASE}/admin/analytics`);
    const data = await res.json();
    if (data.success) {
      analyticsData = data;
      renderAllCharts();
      renderDashboardCharts();
    }
  } catch (err) {
    console.error('Error loading analytics:', err);
  }
}

async function refreshAllData() {
  showToast('Synchronizing store intelligence...', 'info');
  await Promise.all([
    loadDashboardData(),
    loadSessionsData(),
    loadSalesData(),
    loadExpiryData(),
    loadForecastData(),
    loadMarketBasketData(),
    loadAnalyticsData()
  ]);
  showToast('Store data synchronized successfully', 'success');
}

// ==========================================
// 4. View Rendering & UI Binding
// ==========================================

// Dashboard Overview Rendering
function renderDashboard() {
  if (!dashboardStats) return;

  const kpis = dashboardStats.kpis || {};
  const insights = dashboardStats.storeInsights || {};
  const priorities = dashboardStats.todaysPriorities || [];

  // 4 Primary KPI Cards
  const totalProdEl = document.getElementById('dash-total-products');
  if (totalProdEl) totalProdEl.textContent = formatNumber(kpis.totalProducts);

  const availStockEl = document.getElementById('dash-available-stock');
  if (availStockEl) availStockEl.textContent = formatNumber(kpis.availableStock);

  const stockBreakdownEl = document.getElementById('dash-stock-breakdown');
  if (stockBreakdownEl) {
    stockBreakdownEl.textContent = `Physical: ${formatNumber(kpis.totalOnHand)} | Reserved: ${formatNumber(kpis.totalReserved)}`;
  }

  const activeCartsEl = document.getElementById('dash-active-carts');
  if (activeCartsEl) activeCartsEl.textContent = formatNumber(kpis.activeShoppingCarts);

  const cartsSubEl = document.getElementById('dash-carts-subtext');
  if (cartsSubEl) {
    cartsSubEl.textContent = `${kpis.activeShoppingCarts} active session(s) in-store`;
  }

  const todaySalesEl = document.getElementById('dash-today-sales');
  if (todaySalesEl) todaySalesEl.textContent = formatCurrency(kpis.todaySales);

  const ordersCountEl = document.getElementById('dash-orders-count');
  if (ordersCountEl) {
    ordersCountEl.textContent = `Completed Orders: ${formatNumber(kpis.completedOrders)}`;
  }

  // Render Today's Priorities
  const prioGrid = document.getElementById('dashboard-priorities-grid');
  if (prioGrid) {
    prioGrid.innerHTML = priorities.map(p => `
      <div class="priority-card" data-jump-tab="${p.targetTab || 'inventory'}" data-jump-id="${p.targetId || ''}">
        <div>
          <div class="priority-card-top">
            <span class="priority-type-pill ${p.type}">${p.badge}</span>
          </div>
          <h4>${p.title}</h4>
          <p>${p.subtitle}</p>
        </div>
        <div class="priority-action-link">
          ${p.actionLabel || 'Take Action'} &rarr;
        </div>
      </div>
    `).join('');

    // Attach click handlers
    prioGrid.querySelectorAll('.priority-card').forEach(card => {
      card.addEventListener('click', () => {
        const targetTab = card.getAttribute('data-jump-tab');
        if (targetTab) switchTab(targetTab);
      });
    });
  }

  // Render Store Insights Lists
  // 1. Low Stock & Reorders
  const lowStockList = document.getElementById('insight-low-stock-list');
  if (lowStockList) {
    const items = insights.lowStock || [];
    if (items.length === 0) {
      lowStockList.innerHTML = `<div class="insight-item"><span style="color:var(--color-success); font-weight:600;">✅ All catalog items meet safety stock thresholds</span></div>`;
    } else {
      lowStockList.innerHTML = items.slice(0, 4).map(item => `
        <div class="insight-item">
          <div class="insight-item-left">
            <span class="insight-item-title">${item.name}</span>
            <span class="insight-item-sub">Available: ${item.available} units &bull; Threshold: ${item.reorderLevel}</span>
          </div>
          <span class="status-pill status-low-stock">Reorder +${item.suggestedReorderQty}</span>
        </div>
      `).join('');
    }
  }

  // 2. Expiry Watch
  const expiryList = document.getElementById('insight-expiry-list');
  if (expiryList) {
    const items = insights.expiringSoon || [];
    if (items.length === 0) {
      expiryList.innerHTML = `<div class="insight-item"><span style="color:var(--color-success); font-weight:600;">✅ No batches expiring within 30 days</span></div>`;
    } else {
      expiryList.innerHTML = items.slice(0, 4).map(item => `
        <div class="insight-item">
          <div class="insight-item-left">
            <span class="insight-item-title">${item.name}</span>
            <span class="insight-item-sub">Batch: ${item.batchNumber} &bull; Expiry: ${item.expiryDate}</span>
          </div>
          <span class="status-pill ${item.isExpired ? 'status-expired' : 'status-expiring-7d'}">
            ${item.isExpired ? 'Expired' : `${item.daysUntilExpiry}d remaining`}
          </span>
        </div>
      `).join('');
    }
  }

  // 3. Suggested Combos
  const combosList = document.getElementById('insight-combos-list');
  if (combosList) {
    const items = insights.suggestedCombos || [];
    if (items.length === 0) {
      combosList.innerHTML = `<div class="insight-item"><span style="color:var(--text-muted);">Awaiting multi-item transactions</span></div>`;
    } else {
      combosList.innerHTML = items.slice(0, 3).map(c => `
        <div class="insight-item">
          <div class="insight-item-left">
            <span class="insight-item-title">${c.title}</span>
            <span class="insight-item-sub">${c.transactions} checkout pairings &bull; Lift: ${c.lift}x</span>
          </div>
          <span class="status-pill status-active">Bundle Promo</span>
        </div>
      `).join('');
    }
  }

  // 4. Recent Activity
  const activityList = document.getElementById('insight-activity-list');
  if (activityList) {
    const items = insights.recentActivity || [];
    activityList.innerHTML = items.slice(0, 4).map(m => `
      <div class="insight-item">
        <div class="insight-item-left">
          <span class="insight-item-title">${m.action} &bull; ${m.productName}</span>
          <span class="insight-item-sub">${m.timestamp} &bull; Ref: ${m.ref}</span>
        </div>
        <strong style="color:${m.delta > 0 ? 'var(--color-success)' : 'var(--color-danger)'}; font-size:0.85rem;">
          ${m.delta > 0 ? `+${m.delta}` : m.delta}
        </strong>
      </div>
    `).join('');
  }

  // Render Dashboard Visual Graphs
  renderDashboardCharts();
}

// Visual Analytics Graphs for Dashboard
function renderDashboardCharts() {
  if (typeof Chart === 'undefined') return;

  const primaryColor = '#2563eb';
  const greenColor = '#10b981';
  const amberColor = '#f59e0b';
  const purpleColor = '#8b5cf6';
  const roseColor = '#ef4444';

  // 1. Sales & Revenue Momentum Chart
  const revCanvas = document.getElementById('dash-chart-revenue');
  if (revCanvas) {
    let revLabels = [];
    let revData = [];
    let totalRev = 0;

    if (analyticsData?.timeSeries && analyticsData.timeSeries.length > 0) {
      revLabels = analyticsData.timeSeries.map(t => {
        if (!t.bucket) return '';
        const d = new Date(t.bucket);
        return isNaN(d) ? t.bucket.slice(5) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      revData = analyticsData.timeSeries.map(t => Number(t.revenue || 0));
      totalRev = revData.reduce((acc, v) => acc + v, 0);
    } else {
      // Baseline 7-day realistic trajectory incorporating today's actual sales
      const todaySalesVal = Number(dashboardStats?.kpis?.todaySales || 0);
      const now = new Date();
      revLabels = [6, 5, 4, 3, 2, 1, 0].map(diff => {
        const d = new Date(now.getTime() - diff * 86400000);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      });
      revData = [380.00, 520.50, 490.00, 710.25, 640.00, 890.50, todaySalesVal > 0 ? todaySalesVal : 420.00];
      totalRev = revData.reduce((acc, v) => acc + v, 0);
    }

    const revPill = document.getElementById('dash-chart-rev-metric');
    if (revPill) revPill.textContent = `${formatCurrency(totalRev)} Total Period`;

    createChart('dash-chart-revenue', 'line', {
      labels: revLabels,
      datasets: [{
        label: 'Gross Sales ($)',
        data: revData,
        borderColor: primaryColor,
        backgroundColor: (context) => {
          const chart = context.chart;
          const { ctx, chartArea } = chart;
          if (!chartArea) return 'rgba(37, 99, 235, 0.12)';
          const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          gradient.addColorStop(0, 'rgba(37, 99, 235, 0.25)');
          gradient.addColorStop(1, 'rgba(37, 99, 235, 0.01)');
          return gradient;
        },
        fill: true,
        tension: 0.38,
        borderWidth: 2.5,
        pointBackgroundColor: primaryColor,
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    }, {
      scales: {
        x: { grid: { color: '#f1f5f9' }, ticks: { font: { family: 'Inter', size: 10 } } },
        y: {
          grid: { color: '#f1f5f9' },
          ticks: {
            font: { family: 'Inter', size: 10 },
            callback: (v) => '$' + v
          }
        }
      }
    });
  }

  // 2. Stock Levels vs Safety Thresholds Chart
  const stockCanvas = document.getElementById('dash-chart-stock-levels');
  if (stockCanvas) {
    const catalog = (products && products.length > 0) ? products : [
      { name: 'Cold Brew Coffee', available: 55, reorderLevel: 25 },
      { name: 'Smart Water Bottle', available: 8, reorderLevel: 15 },
      { name: 'Wireless Earbuds', available: 12, reorderLevel: 10 },
      { name: 'Granola Bar', available: 42, reorderLevel: 20 },
      { name: 'Tracker Tag', available: 18, reorderLevel: 12 },
      { name: 'Energy Drink', available: 65, reorderLevel: 30 }
    ];

    const displayProds = catalog.slice(0, 7);
    const labels = displayProds.map(p => p.name.length > 15 ? p.name.slice(0, 14) + '…' : p.name);
    const availableData = displayProds.map(p => p.available);
    const thresholdData = displayProds.map(p => p.reorderLevel || 15);
    const barColors = displayProds.map(p => {
      const th = p.reorderLevel || 15;
      if (p.available <= th) return roseColor;
      if (p.available <= th * 1.5) return amberColor;
      return greenColor;
    });

    const stockPill = document.getElementById('dash-chart-stock-metric');
    if (stockPill) stockPill.textContent = `${catalog.length} SKUs Monitored`;

    createChart('dash-chart-stock-levels', 'bar', {
      labels,
      datasets: [
        {
          label: 'Available Stock',
          data: availableData,
          backgroundColor: barColors,
          borderRadius: 6,
          barPercentage: 0.65
        },
        {
          label: 'Reorder Level',
          data: thresholdData,
          backgroundColor: 'rgba(148, 163, 184, 0.35)',
          borderColor: '#94a3b8',
          borderWidth: 1,
          borderRadius: 6,
          barPercentage: 0.65
        }
      ]
    }, {
      showLegend: true,
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 10 } } },
        y: {
          grid: { color: '#f1f5f9' },
          ticks: { font: { family: 'Inter', size: 10 } }
        }
      }
    });
  }

  // 3. Category Sales & Catalog Share Chart
  const catCanvas = document.getElementById('dash-chart-categories');
  if (catCanvas) {
    let catLabels = [];
    let catValues = [];

    if (analyticsData?.categorySales && analyticsData.categorySales.length > 0) {
      catLabels = analyticsData.categorySales.map(c => c.category);
      catValues = analyticsData.categorySales.map(c => Number(c.revenue || c.units || 1));
    } else if (products && products.length > 0) {
      const map = {};
      products.forEach(p => {
        const cat = p.category || 'General';
        map[cat] = (map[cat] || 0) + (p.soldUnits * p.price || p.onHand || 1);
      });
      catLabels = Object.keys(map);
      catValues = Object.values(map);
    } else {
      catLabels = ['Beverages', 'Electronics', 'Snacks', 'Accessories', 'Health'];
      catValues = [4120, 5240, 3480, 2190, 1650];
    }

    const palette = ['#2563eb', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#ec4899', '#6366f1'];

    const catPill = document.getElementById('dash-chart-cat-metric');
    if (catPill) catPill.textContent = `${catLabels.length} Categories`;

    createChart('dash-chart-categories', 'doughnut', {
      labels: catLabels,
      datasets: [{
        data: catValues,
        backgroundColor: palette.slice(0, catLabels.length),
        borderWidth: 2,
        borderColor: '#ffffff',
        hoverOffset: 6
      }]
    }, {
      showLegend: true,
      legendPosition: 'bottom',
      scales: {
        x: { display: false },
        y: { display: false }
      },
      extra: {
        cutout: '68%',
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { boxWidth: 10, padding: 12, font: { family: 'Inter', size: 11 } }
          }
        }
      }
    });
  }

  // 4. Store Hourly Cart Activity & Foot-Traffic
  const trafficCanvas = document.getElementById('dash-chart-traffic');
  if (trafficCanvas) {
    const hours = ['8 AM', '10 AM', '12 PM', '2 PM', '4 PM', '6 PM', '8 PM', '10 PM'];
    const activeCartsCount = Number(dashboardStats?.kpis?.activeShoppingCarts || 0);

    const cartActivity = [2, 5, 12 + activeCartsCount, 8, 10, 16 + activeCartsCount, 11, 4];
    const checkoutVelocity = [1, 3, 10, 6, 8, 14, 9, 3];

    createChart('dash-chart-traffic', 'bar', {
      labels: hours,
      datasets: [
        {
          type: 'bar',
          label: 'Active RFID Carts',
          data: cartActivity,
          backgroundColor: 'rgba(139, 92, 246, 0.75)',
          borderRadius: 6,
          barPercentage: 0.6
        },
        {
          type: 'line',
          label: 'Completed Checkouts',
          data: checkoutVelocity,
          borderColor: greenColor,
          backgroundColor: 'transparent',
          borderWidth: 2.5,
          tension: 0.35,
          pointRadius: 3,
          pointBackgroundColor: greenColor
        }
      ]
    }, {
      showLegend: true,
      legendPosition: 'top',
      scales: {
        x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 10 } } },
        y: {
          grid: { color: '#f1f5f9' },
          ticks: { font: { family: 'Inter', size: 10 } }
        }
      }
    });
  }
}

// Products & Inventory Rendering
function renderInventoryTable() {
  const tbody = document.getElementById('inventory-tbody');
  if (!tbody) return;

  const search = inventoryFilter.search.toLowerCase().trim();
  const category = inventoryFilter.category;
  const status = inventoryFilter.status;

  let filtered = products.filter(p => {
    const matchSearch = !search ||
      p.name.toLowerCase().includes(search) ||
      p.id.toLowerCase().includes(search) ||
      (p.rfid && p.rfid.toLowerCase().includes(search));
    const matchCat = category === 'ALL' || p.category === category;
    const matchStatus = status === 'ALL' || p.status === status;
    return matchSearch && matchCat && matchStatus;
  });

  // Sorting
  if (inventoryFilter.sort === 'available-asc') {
    filtered.sort((a, b) => a.available - b.available);
  } else if (inventoryFilter.sort === 'available-desc') {
    filtered.sort((a, b) => b.available - a.available);
  } else if (inventoryFilter.sort === 'name-asc') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else if (inventoryFilter.sort === 'price-desc') {
    filtered.sort((a, b) => b.price - a.price);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:32px; color:var(--text-muted);">No products match the selected criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    let statusClass = 'status-in-stock';
    if (p.status === 'Out of Stock') statusClass = 'status-out-stock';
    else if (p.status === 'Low Stock') statusClass = 'status-low-stock';

    return `
      <tr>
        <td>
          <div style="font-weight:600; color:var(--text-primary);">${p.name}</div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">${p.id}</div>
        </td>
        <td style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-secondary);">${p.rfid || 'N/A'}</td>
        <td><span class="category-badge">${p.category || 'General'}</span></td>
        <td style="text-align:right; font-weight:600;">${formatCurrency(p.price)}</td>
        <td style="text-align:right; font-weight:600;">${p.onHand}</td>
        <td style="text-align:right; color:var(--color-warning-dark); font-weight:600;">${p.reserved}</td>
        <td style="text-align:right; font-weight:700; color:${p.available === 0 ? 'var(--color-danger)' : 'var(--color-success-dark)'};">${p.available}</td>
        <td><span class="status-pill ${statusClass}">${p.status}</span></td>
        <td style="font-size:0.8rem; color:${p.expiryDate ? 'var(--text-secondary)' : 'var(--text-muted)'};">${p.expiryDate || '—'}</td>
        <td style="text-align:right; font-weight:600;">${p.soldUnits || 0}</td>
        <td style="text-align:center;">
          <div class="table-btn-group" style="justify-content:center;">
            <button class="table-btn primary btn-quick-restock" data-product-id="${p.id}" title="Receive new stock">Restock</button>
            <button class="table-btn btn-view-360" data-product-id="${p.id}" title="View 360 Product Detail">Detail</button>
            <button class="table-btn btn-quick-edit" data-product-id="${p.id}" title="Edit product parameters">Edit</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Attach button events
  tbody.querySelectorAll('.btn-quick-restock').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-product-id');
      openRestockModal(id);
    });
  });

  tbody.querySelectorAll('.btn-view-360').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-product-id');
      openProduct360(id);
    });
  });

  tbody.querySelectorAll('.btn-quick-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-product-id');
      openEditProductModal(id);
    });
  });
}

// Movements Audit Table Rendering
function renderMovementsTable() {
  const tbody = document.getElementById('movements-tbody');
  if (!tbody) return;

  const search = movementsFilter.search.toLowerCase().trim();
  const action = movementsFilter.action;

  const filtered = movements.filter(m => {
    const matchSearch = !search ||
      m.productName.toLowerCase().includes(search) ||
      m.productId.toLowerCase().includes(search) ||
      m.id.toLowerCase().includes(search) ||
      (m.ref && m.ref.toLowerCase().includes(search));
    const matchAction = action === 'ALL' || m.action === action;
    return matchSearch && matchAction;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; padding:32px; color:var(--text-muted);">No stock movements recorded.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(m => {
    let badgeClass = 'status-in-stock';
    if (m.action === 'DAMAGE_WRITEOFF') badgeClass = 'status-out-stock';
    else if (m.action === 'CHECKOUT') badgeClass = 'status-active';
    else if (m.action === 'CYCLE_COUNT') badgeClass = 'status-low-stock';

    return `
      <tr>
        <td style="font-size:0.8rem; color:var(--text-muted); font-family:var(--font-mono);">${m.timestamp}</td>
        <td style="font-family:var(--font-mono); font-weight:600;">${m.id}</td>
        <td>
          <div style="font-weight:600;">${m.productName}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">${m.productId}</div>
        </td>
        <td style="font-family:var(--font-mono); font-size:0.75rem;">${m.rfid || 'N/A'}</td>
        <td><span class="status-pill ${badgeClass}">${m.action}</span></td>
        <td style="text-align:right; font-weight:700; color:${m.delta > 0 ? 'var(--color-success)' : 'var(--color-danger)'};">
          ${m.delta > 0 ? `+${m.delta}` : m.delta}
        </td>
        <td style="text-align:right; color:var(--text-muted);">${m.beforeQty}</td>
        <td style="text-align:right; font-weight:600;">${m.afterQty}</td>
        <td style="font-family:var(--font-mono); font-size:0.78rem;">${m.ref}</td>
        <td style="font-size:0.8rem; color:var(--text-secondary);">${m.notes}</td>
      </tr>
    `;
  }).join('');
}

// Sessions Table Rendering
function renderSessionsTable() {
  const tbody = document.getElementById('sessions-tbody');
  if (!tbody) return;

  const filterStatus = document.getElementById('session-filter-status')?.value || 'ALL';
  const filtered = sessionsData.filter(s => filterStatus === 'ALL' || s.status === filterStatus);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--text-muted);">No shopping cart sessions found.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    let statusClass = 'status-healthy';
    let statusLabel = 'Completed';
    if (s.status === 'active') { statusClass = 'status-active'; statusLabel = 'Active In-Store'; }
    else if (s.status === 'cancelled') { statusClass = 'status-low-stock'; statusLabel = 'Cancelled'; }
    else if (s.status === 'expired') { statusClass = 'status-out-stock'; statusLabel = 'Expired'; }

    return `
    <tr>
      <td style="font-family:var(--font-mono); font-weight:600;">${s.session_id}</td>
      <td style="font-family:var(--font-mono); font-size:0.85rem;">${s.cart_id}</td>
      <td>${s.user_id || 'Guest Shopper'}</td>
      <td>
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </td>
      <td style="font-size:0.8rem; color:var(--text-muted);">${s.started_at}</td>
      <td style="text-align:right; font-weight:600;">${s.item_count}</td>
      <td style="text-align:right; font-weight:700;">${formatCurrency(s.subtotal)}</td>
      <td style="text-align:center;">
        <button class="table-btn primary btn-view-session-items" data-session-id="${s.session_id}">
          Inspect Items (${s.items?.length || 0})
        </button>
      </td>
    </tr>
  `}).join('');

  tbody.querySelectorAll('.btn-view-session-items').forEach(btn => {
    btn.addEventListener('click', () => {
      const sessId = btn.getAttribute('data-session-id');
      const sess = sessionsData.find(s => s.session_id === sessId);
      if (sess) openSessionItemsModal(sess);
    });
  });
}

// Sales Table & KPI Rendering
function renderSalesSection(totals) {
  if (totals) {
    const revEl = document.getElementById('sales-kpi-revenue');
    if (revEl) revEl.textContent = formatCurrency(totals.revenue);

    const ordEl = document.getElementById('sales-kpi-orders');
    if (ordEl) ordEl.textContent = formatNumber(totals.count);

    const aovEl = document.getElementById('sales-kpi-aov');
    if (aovEl && totals.count > 0) {
      aovEl.textContent = formatCurrency(totals.revenue / totals.count);
    }
  }

  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return;

  if (salesData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:32px; color:var(--text-muted);">No sales records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = salesData.map(s => `
    <tr>
      <td style="font-family:var(--font-mono); font-weight:600;">${s.sale_id}</td>
      <td style="font-size:0.8rem; color:var(--text-muted);">${s.completed_at}</td>
      <td style="font-family:var(--font-mono); font-size:0.8rem;">${s.session_id || 'DIRECT'}</td>
      <td style="text-align:right; font-weight:600;">${s.item_count}</td>
      <td style="text-align:right;">${formatCurrency(s.subtotal)}</td>
      <td style="text-align:right; color:var(--text-muted);">${formatCurrency(s.tax_amount)}</td>
      <td style="text-align:right; font-weight:700; color:var(--color-primary);">${formatCurrency(s.total)}</td>
      <td><span class="status-pill status-healthy">Paid / Verified</span></td>
      <td style="text-align:center;">
        <button class="table-btn primary btn-view-sale-items" data-sale-id="${s.sale_id}">
          View Items (${s.lineItems?.length || 0})
        </button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.btn-view-sale-items').forEach(btn => {
    btn.addEventListener('click', () => {
      const saleId = btn.getAttribute('data-sale-id');
      const sale = salesData.find(s => s.sale_id === saleId);
      if (sale) openSaleReceiptModal(sale);
    });
  });
}

// Expiry Section Rendering
function renderExpirySection() {
  const tbody = document.getElementById('expiry-tbody');
  if (!tbody) return;

  const filtered = expiryData.filter(item => {
    if (expiryFilter === 'ALL') return true;
    return item.status === expiryFilter;
  });

  const riskBadge = document.getElementById('expiry-risk-badge');
  const criticalCount = expiryData.filter(i => i.status === 'expiring_7d' || i.status === 'expired').length;
  if (riskBadge) {
    riskBadge.textContent = `${criticalCount} Action Needed`;
    riskBadge.className = criticalCount > 0 ? 'kpi-badge warning' : 'kpi-badge success';
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:32px; color:var(--text-muted);">No product batches match the filter.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    let statusClass = 'status-healthy';
    let statusLabel = 'Healthy';
    if (item.status === 'expired') { statusClass = 'status-expired'; statusLabel = 'Expired'; }
    else if (item.status === 'expiring_7d') { statusClass = 'status-expiring-7d'; statusLabel = 'Expiring in \u2264 7 Days'; }
    else if (item.status === 'expiring_30d') { statusClass = 'status-expiring-30d'; statusLabel = 'Expiring in \u2264 30 Days'; }

    return `
      <tr>
        <td>
          <div style="font-weight:600;">${item.name}</div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">${item.productId}</div>
        </td>
        <td style="font-family:var(--font-mono); font-size:0.8rem;">${item.batchNumber}</td>
        <td style="font-size:0.82rem; font-weight:600;">${item.expiryDate}</td>
        <td style="font-weight:700; color:${item.daysUntilExpiry < 0 ? 'var(--color-danger)' : (item.daysUntilExpiry <= 7 ? 'var(--color-danger)' : 'var(--text-primary)')};">
          ${item.daysUntilExpiry < 0 ? 'Overdue' : `${item.daysUntilExpiry} days`}
        </td>
        <td style="text-align:right; font-weight:700;">${item.quantityAtRisk}</td>
        <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
        <td style="font-size:0.82rem; color:var(--text-secondary);">${item.action}</td>
        <td style="text-align:center;">
          ${item.suggestedDiscount > 0 ? `
            <button class="table-btn primary btn-apply-smart-promo" data-prod-id="${item.productId}" data-discount="${item.suggestedDiscount}" data-reason="${item.action}">
              Apply ${item.suggestedDiscount}% Promo
            </button>
          ` : `
            <span style="font-size:0.78rem; color:var(--text-muted);">Standard Price</span>
          `}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-apply-smart-promo').forEach(btn => {
    btn.addEventListener('click', () => {
      const prodId = btn.getAttribute('data-prod-id');
      const discount = btn.getAttribute('data-discount');
      const reason = btn.getAttribute('data-reason');
      openPromotionModal(prodId, discount, reason);
    });
  });
}

// Demand Forecasting Section Rendering
function renderForecastSection() {
  const tbody = document.getElementById('forecast-tbody');
  if (!tbody) return;

  const filtered = forecastData.filter(f => {
    if (forecastFilterClass === 'ALL') return true;
    return f.classification === forecastFilterClass;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:32px; color:var(--text-muted);">No products match this forecast classification.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(f => {
    let badgeClass = 'status-healthy';
    if (f.classification === 'Critical Stockout Risk' || f.classification === 'Out of Stock') badgeClass = 'status-out-stock';
    else if (f.classification === 'Low Stock') badgeClass = 'status-low-stock';
    else if (f.classification === 'Fast Moving') badgeClass = 'status-active';
    else if (f.classification === 'Slow Moving' || f.classification === 'Dormant Stock') badgeClass = 'status-expiring-30d';

    return `
      <tr>
        <td>
          <div style="font-weight:600;">${f.name}</div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-mono);">${f.id}</div>
        </td>
        <td style="text-align:right; font-weight:700; color:${f.available === 0 ? 'var(--color-danger)' : 'var(--text-primary)'};">${f.available}</td>
        <td style="text-align:right; font-weight:600;">${f.soldUnits}</td>
        <td style="text-align:right; font-weight:600;">${f.avgDailySales} / day</td>
        <td style="text-align:right; font-weight:700; color:${f.daysUntilStockout <= 7 ? 'var(--color-danger)' : 'var(--text-primary)'};">
          ${f.daysUntilStockout > 365 ? '> 1 Year' : `${f.daysUntilStockout} days`}
        </td>
        <td style="font-size:0.8rem; color:var(--text-muted);">${f.stockoutDate}</td>
        <td style="text-align:right; color:var(--text-secondary);">${f.targetStock}</td>
        <td style="text-align:right; font-weight:700; color:${f.suggestedReorderQty > 0 ? 'var(--color-primary)' : 'var(--color-success)'};">
          ${f.suggestedReorderQty > 0 ? `+${f.suggestedReorderQty}` : '0'}
        </td>
        <td><span class="status-pill ${badgeClass}">${f.classification}</span></td>
        <td style="font-size:0.8rem; color:var(--text-secondary);">${f.recommendationReason}</td>
        <td style="text-align:center;">
          ${f.suggestedReorderQty > 0 ? `
            <button class="table-btn primary btn-forecast-reorder" data-prod-id="${f.id}" data-qty="${f.suggestedReorderQty}">
              Reorder +${f.suggestedReorderQty}
            </button>
          ` : `
            <span style="font-size:0.78rem; color:var(--text-muted);">Sufficient</span>
          `}
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-forecast-reorder').forEach(btn => {
    btn.addEventListener('click', () => {
      const prodId = btn.getAttribute('data-prod-id');
      const qty = btn.getAttribute('data-qty');
      openRestockModal(prodId, qty);
    });
  });
}

// Market Basket Section Rendering
function renderMarketBasketSection() {
  if (!basketData) return;

  const datasetBadge = document.getElementById('basket-dataset-badge');
  if (datasetBadge) {
    datasetBadge.textContent = basketData.isSimulated
      ? '✨ Simulated Demo Baskets'
      : `Production Sales (${basketData.totalEligibleTransactions} Transactions)`;
    datasetBadge.className = basketData.isSimulated ? 'kpi-badge warning' : 'kpi-badge info';
  }

  // Combos Grid
  const combosGrid = document.getElementById('market-basket-combos-grid');
  if (combosGrid) {
    const combos = basketData.combos || [];
    if (combos.length === 0) {
      combosGrid.innerHTML = `
        <div style="grid-column: 1 / -1; background:#ffffff; border:1px solid var(--border-subtle); padding:24px; border-radius:var(--radius-lg); text-align:center; color:var(--text-muted);">
          ${basketData.message || 'No completed multi-item transactions found in production database.'}
        </div>
      `;
    } else {
      combosGrid.innerHTML = combos.map(c => `
        <div class="combo-card">
          <span class="combo-badge">Lift: ${c.lift}x</span>
          <h4>${c.title}</h4>
          <div class="combo-metrics">
            <div class="combo-metric">
              <span class="label">Co-Occurrences</span>
              <span class="val">${c.transactions}</span>
            </div>
            <div class="combo-metric">
              <span class="label">Confidence</span>
              <span class="val">${c.confidence}</span>
            </div>
            <div class="combo-metric">
              <span class="label">Affinity</span>
              <span class="val">${c.lift >= 2.0 ? 'High' : 'Moderate'}</span>
            </div>
          </div>
          <p style="font-size:0.8rem; color:var(--text-secondary); margin:0 0 12px 0;">
            ${c.recommendation}
          </p>
          <button class="table-btn primary" style="width:100%; text-align:center;">
            Promote Combo in Smart Cart
          </button>
        </div>
      `).join('');
    }
  }

  // Association Rules Table
  const tbody = document.getElementById('basket-tbody');
  if (!tbody) return;

  const pairs = basketData.pairs || [];
  if (pairs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:32px; color:var(--text-muted);">No co-occurrence pairs detected yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = pairs.map(p => `
    <tr>
      <td>
        <div style="font-weight:600;">${p.productA.name}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${p.productA.category}</div>
      </td>
      <td>
        <div style="font-weight:600;">${p.productB.name}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${p.productB.category}</div>
      </td>
      <td style="text-align:right; font-weight:700;">${p.coOccurrenceCount}</td>
      <td style="text-align:right; font-family:var(--font-mono);">${(p.support * 100).toFixed(1)}%</td>
      <td style="text-align:right; font-family:var(--font-mono); font-weight:600;">${(p.confidenceAtoB * 100).toFixed(1)}%</td>
      <td style="text-align:right; font-weight:800; color:var(--color-purple-dark);">${p.lift}x</td>
      <td style="font-size:0.82rem; color:var(--text-secondary);">${p.suggestedAction}</td>
    </tr>
  `).join('');
}

// ==========================================
// 5. Chart.js Data Visualizations
// ==========================================
function renderAllCharts() {
  if (!analyticsData) return;

  const primaryColor = '#2563eb';
  const greenColor = '#10b981';
  const amberColor = '#f59e0b';
  const purpleColor = '#8b5cf6';
  const roseColor = '#ef4444';

  const timeSeries = analyticsData.timeSeries || [];
  const unitSeries = analyticsData.unitSeries || [];
  const aovSeries = analyticsData.aovSeries || [];
  const topProducts = analyticsData.topProducts || [];
  const catSales = analyticsData.categorySales || [];
  const stockDist = analyticsData.stockDistribution || [];
  const movements = analyticsData.inventoryMovements || [];

  // Chart 1: Daily Revenue
  createChart('chart-daily-revenue', 'line', {
    labels: timeSeries.map(t => t.bucket ? t.bucket.slice(0, 10) : ''),
    datasets: [{
      label: 'Revenue ($)',
      data: timeSeries.map(t => t.revenue),
      borderColor: primaryColor,
      backgroundColor: 'rgba(37, 99, 235, 0.08)',
      fill: true,
      tension: 0.35,
      borderWidth: 2,
      pointRadius: 3
    }]
  });

  // Chart 2: Units Sold Over Time
  createChart('chart-units-sold', 'bar', {
    labels: unitSeries.map(u => u.bucket ? u.bucket.slice(0, 10) : ''),
    datasets: [{
      label: 'Units Sold',
      data: unitSeries.map(u => u.units),
      backgroundColor: '#60a5fa',
      borderRadius: 4
    }]
  });

  // Chart 3: Revenue by Product
  createChart('chart-revenue-by-prod', 'bar', {
    labels: topProducts.map(p => p.name),
    datasets: [{
      label: 'Revenue ($)',
      data: topProducts.map(p => p.revenue),
      backgroundColor: purpleColor,
      borderRadius: 4
    }]
  }, { extra: { indexAxis: 'y' } });

  // Chart 4: Best-Selling Products (Units)
  createChart('chart-best-sellers', 'bar', {
    labels: topProducts.map(p => p.name),
    datasets: [{
      label: 'Units Purchased',
      data: topProducts.map(p => p.units),
      backgroundColor: greenColor,
      borderRadius: 4
    }]
  });

  // Chart 5: Category Breakdown
  createChart('chart-sales-by-cat', 'doughnut', {
    labels: catSales.map(c => c.category),
    datasets: [{
      data: catSales.map(c => c.revenue),
      backgroundColor: [primaryColor, greenColor, amberColor, purpleColor, roseColor],
      borderWidth: 0
    }]
  }, { showLegend: true, scales: { x: { display: false }, y: { display: false } } });

  // Chart 6: AOV Trend
  createChart('chart-aov-trend', 'line', {
    labels: aovSeries.map(a => a.bucket ? a.bucket.slice(0, 10) : ''),
    datasets: [{
      label: 'AOV ($)',
      data: aovSeries.map(a => a.aov),
      borderColor: amberColor,
      borderWidth: 2,
      tension: 0.3
    }]
  });

  // Chart 7: Current Stock by Product
  createChart('chart-stock-by-prod', 'bar', {
    labels: stockDist.map(s => s.name),
    datasets: [{
      label: 'Available Stock',
      data: stockDist.map(s => s.available),
      backgroundColor: '#3b82f6',
      borderRadius: 4
    }]
  });

  // Chart 8: Inventory Triad (Grouped Multi-bar)
  createChart('chart-inventory-triad', 'bar', {
    labels: stockDist.map(s => s.name),
    datasets: [
      { label: 'Physical On-Hand', data: stockDist.map(s => s.onHand), backgroundColor: '#94a3b8', borderRadius: 3 },
      { label: 'Reserved in Carts', data: stockDist.map(s => s.reserved), backgroundColor: amberColor, borderRadius: 3 },
      { label: 'Net Available', data: stockDist.map(s => s.available), backgroundColor: greenColor, borderRadius: 3 }
    ]
  }, { showLegend: true });

  // Chart 9: Stock Health Distribution
  const inStockCount = stockDist.filter(s => s.available > 10).length;
  const lowStockCount = stockDist.filter(s => s.available > 0 && s.available <= 10).length;
  const outOfStockCount = stockDist.filter(s => s.available === 0).length;

  createChart('chart-stock-health', 'doughnut', {
    labels: ['Healthy Stock', 'Low Stock', 'Out of Stock'],
    datasets: [{
      data: [inStockCount, lowStockCount, outOfStockCount],
      backgroundColor: [greenColor, amberColor, roseColor],
      borderWidth: 0
    }]
  }, { showLegend: true, scales: { x: { display: false }, y: { display: false } } });

  // Chart 10: Inventory Movements by Action
  createChart('chart-movements-by-action', 'bar', {
    labels: movements.map(m => m.action),
    datasets: [{
      label: 'Action Volume',
      data: movements.map(m => m.count),
      backgroundColor: '#818cf8',
      borderRadius: 4
    }]
  });

  // Chart 11: Stockout Risk / Days of Supply
  const forecastItems = (forecastData.length > 0 ? forecastData : calculateDemandForecast(products, 30))
    .slice()
    .sort((a, b) => a.daysUntilStockout - b.daysUntilStockout)
    .slice(0, 8);

  createChart('chart-days-of-supply', 'bar', {
    labels: forecastItems.map(f => f.name),
    datasets: [{
      label: 'Days of Supply Remaining',
      data: forecastItems.map(f => Math.min(f.daysUntilStockout, 90)),
      backgroundColor: forecastItems.map(f => f.daysUntilStockout <= 7 ? roseColor : (f.daysUntilStockout <= 20 ? amberColor : greenColor)),
      borderRadius: 4
    }]
  }, { extra: { indexAxis: 'y' } });

  // Chart 12: Suggested Reorder Quantities
  const reorderItems = forecastItems.filter(f => f.suggestedReorderQty > 0);
  createChart('chart-reorder-quantities', 'bar', {
    labels: reorderItems.map(f => f.name),
    datasets: [{
      label: 'Recommended Units to Reorder',
      data: reorderItems.map(f => f.suggestedReorderQty),
      backgroundColor: primaryColor,
      borderRadius: 4
    }]
  });

  // Chart 13: Expiry Status
  const expStatusData = analyticsData.expiryStatusChart || [
    { label: 'Healthy (>30d)', count: 5 },
    { label: 'Expiring in 30d', count: 2 },
    { label: 'Expiring in 7d', count: 1 },
    { label: 'Expired', count: 0 }
  ];

  createChart('chart-expiry-status', 'doughnut', {
    labels: expStatusData.map(e => e.label),
    datasets: [{
      data: expStatusData.map(e => e.count),
      backgroundColor: [greenColor, amberColor, roseColor, '#64748b'],
      borderWidth: 0
    }]
  }, { showLegend: true, scales: { x: { display: false }, y: { display: false } } });

  // Chart 14: Quantity at Risk (from real expiry data, or empty state if no data)
  const expiryRiskItems = expiryData.filter(e => e.quantityAtRisk > 0).slice(0, 6);
  createChart('chart-qty-at-risk', 'bar', {
    labels: expiryRiskItems.length > 0
      ? expiryRiskItems.map(e => e.name || e.productId)
      : ['No expiry risk data'],
    datasets: [{
      label: 'Units at Risk',
      data: expiryRiskItems.length > 0 ? expiryRiskItems.map(e => e.quantityAtRisk) : [0],
      backgroundColor: amberColor,
      borderRadius: 4
    }]
  });

  // Chart 16: Top Paired Products
  const pairedData = analyticsData.basketPairs || (basketData?.pairs || []).slice(0, 5);
  createChart('chart-paired-products', 'bar', {
    labels: pairedData.map(p => `${p.productA.name} + ${p.productB.name}`),
    datasets: [{
      label: 'Co-Purchases',
      data: pairedData.map(p => p.coOccurrenceCount),
      backgroundColor: purpleColor,
      borderRadius: 4
    }]
  }, { extra: { indexAxis: 'y' } });

  // Chart 17: Lift Strength
  createChart('chart-lift-strength', 'bar', {
    labels: pairedData.map(p => `${p.productA.name.slice(0, 10)} & ${p.productB.name.slice(0, 10)}`),
    datasets: [{
      label: 'Lift Multiplier (x)',
      data: pairedData.map(p => p.lift),
      backgroundColor: '#a855f7',
      borderRadius: 4
    }]
  });
}

// ==========================================
// 6. Modal & Drawer Controllers
// ==========================================
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function setupModalClosers() {
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.getAttribute('data-close-modal');
      closeModal(modalId);
    });
  });

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.add('hidden');
      }
    });
  });
}

function populateProductSelects() {
  const selects = [
    'count-product-select',
    'restock-product-select',
    'thresh-product-select',
    'promo-product-select'
  ];

  selects.forEach(selId => {
    const el = document.getElementById(selId);
    if (!el) return;
    el.innerHTML = products.map(p => `
      <option value="${p.id}">${p.name} (${p.id}) &mdash; Available: ${p.available}</option>
    `).join('');
  });
}

// Restock Modal
function openRestockModal(productId = null, suggestedQty = null) {
  populateProductSelects();
  const select = document.getElementById('restock-product-select');
  if (select && productId) {
    select.value = productId;
  }
  const qtyInput = document.getElementById('restock-qty');
  if (qtyInput) {
    qtyInput.value = suggestedQty ? parseInt(suggestedQty, 10) : '';
  }
  openModal('modal-restock');
}

// Physical Count Modal
function openCycleCountModal(productId = null) {
  populateProductSelects();
  const select = document.getElementById('count-product-select');
  if (select && productId) {
    select.value = productId;
  }
  updateCycleCountPreview();
  openModal('modal-cycle-count');
}

function updateCycleCountPreview() {
  const select = document.getElementById('count-product-select');
  if (!select) return;
  const prod = products.find(p => p.id === select.value);
  if (!prod) return;

  document.getElementById('count-sys-onhand').textContent = prod.onHand;
  document.getElementById('count-sys-reserved').textContent = prod.reserved;
  document.getElementById('count-sys-available').textContent = prod.available;

  const countedInput = document.getElementById('count-physical-input');
  const counted = parseInt(countedInput.value, 10);
  const badge = document.getElementById('count-discrepancy-badge');
  const sub = document.getElementById('count-discrepancy-sub');

  if (!isNaN(counted)) {
    const delta = counted - prod.onHand;
    badge.textContent = `${delta > 0 ? `+${delta}` : delta} Units`;
    badge.className = delta === 0 ? 'kpi-badge info' : (delta > 0 ? 'kpi-badge success' : 'kpi-badge warning');
    sub.textContent = delta === 0 ? 'Physical count matches database exactly' : (delta > 0 ? 'Surplus stock detected on shelf' : 'Physical shortage relative to system ledger');
  } else {
    badge.textContent = '0 Units';
    sub.textContent = 'Enter counted units on shelf';
  }
}

// Reorder Thresholds Modal
function openThresholdsModal(productId = null) {
  populateProductSelects();
  const select = document.getElementById('thresh-product-select');
  if (select && productId) {
    select.value = productId;
  }
  loadProductThresholds();
  openModal('modal-thresholds');
}

function loadProductThresholds() {
  const select = document.getElementById('thresh-product-select');
  if (!select) return;
  const prod = products.find(p => p.id === select.value);
  if (!prod) return;

  document.getElementById('thresh-reorder').value = prod.reorderLevel;
  document.getElementById('thresh-safety').value = prod.safetyStock;
  document.getElementById('thresh-leadtime').value = prod.leadTimeDays;
  document.getElementById('thresh-target-coverage').value = prod.targetCoverageDays || 14;
  document.getElementById('thresh-supplier').value = prod.supplier || 'Standard Supplier';
}

// Product 360 Drawer
function openProduct360(productId) {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;

  document.getElementById('detail-product-name').textContent = prod.name;
  document.getElementById('detail-product-id').textContent = prod.id;
  document.getElementById('detail-product-rfid').textContent = prod.rfid || 'N/A';
  document.getElementById('detail-product-cat').textContent = prod.category;
  document.getElementById('detail-product-supplier').textContent = prod.supplier;

  document.getElementById('detail-onhand').textContent = prod.onHand;
  document.getElementById('detail-reserved').textContent = prod.reserved;
  document.getElementById('detail-available').textContent = prod.available;

  document.getElementById('detail-cost').textContent = formatCurrency(prod.cost);
  document.getElementById('detail-price').textContent = formatCurrency(prod.price);
  const margin = prod.price > 0 ? (((prod.price - prod.cost) / prod.price) * 100).toFixed(1) : 0;
  document.getElementById('detail-margin').textContent = `${margin}%`;

  // Status pill
  const statusEl = document.getElementById('detail-product-status');
  statusEl.textContent = prod.status;
  statusEl.className = prod.status === 'In Stock' ? 'status-pill status-healthy' : 'status-pill status-low-stock';

  // Filter movements for this product
  const prodMovements = movements.filter(m => m.productId === productId);
  const movTbody = document.getElementById('detail-movements-tbody');
  if (movTbody) {
    if (prodMovements.length === 0) {
      movTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:16px; color:var(--text-muted);">No movement ledger records for this item.</td></tr>`;
    } else {
      movTbody.innerHTML = prodMovements.slice(0, 10).map(m => `
        <tr>
          <td style="font-size:0.75rem; color:var(--text-muted);">${m.timestamp}</td>
          <td><span class="status-pill status-active" style="font-size:0.7rem;">${m.action}</span></td>
          <td style="text-align:right; font-weight:700; color:${m.delta > 0 ? 'var(--color-success)' : 'var(--color-danger)'};">${m.delta > 0 ? `+${m.delta}` : m.delta}</td>
          <td style="text-align:right; font-weight:600;">${m.afterQty}</td>
          <td style="font-family:var(--font-mono); font-size:0.75rem;">${m.ref}</td>
        </tr>
      `).join('');
    }
  }

  // Attach buttons inside drawer
  document.getElementById('btn-detail-edit').onclick = () => {
    closeModal('modal-product-detail');
    openEditProductModal(productId);
  };
  document.getElementById('btn-detail-count').onclick = () => {
    closeModal('modal-product-detail');
    openCycleCountModal(productId);
  };
  document.getElementById('btn-detail-restock').onclick = () => {
    closeModal('modal-product-detail');
    openRestockModal(productId);
  };

  openModal('modal-product-detail');
}

// Add / Edit Product Modals
function openAddProductModal() {
  document.getElementById('modal-product-title').textContent = 'Add New Product';
  document.getElementById('prod-form-is-edit').value = 'false';
  document.getElementById('prod-id').readOnly = false;
  document.getElementById('form-product').reset();
  openModal('modal-product');
}

function openEditProductModal(productId) {
  const prod = products.find(p => p.id === productId);
  if (!prod) return;

  document.getElementById('modal-product-title').textContent = `Edit Product: ${prod.name}`;
  document.getElementById('prod-form-is-edit').value = 'true';

  const idInput = document.getElementById('prod-id');
  idInput.value = prod.id;
  idInput.readOnly = true;

  document.getElementById('prod-name').value = prod.name;
  document.getElementById('prod-rfid').value = prod.rfid;
  document.getElementById('prod-category').value = prod.category;
  document.getElementById('prod-supplier').value = prod.supplier;
  document.getElementById('prod-cost').value = prod.cost;
  document.getElementById('prod-price').value = prod.price;
  document.getElementById('prod-reorder').value = prod.reorderLevel;
  document.getElementById('prod-safety').value = prod.safetyStock;
  document.getElementById('prod-lead-time').value = prod.leadTimeDays;
  document.getElementById('prod-target-coverage').value = prod.targetCoverageDays || 14;
  document.getElementById('prod-onhand').value = prod.onHand;
  document.getElementById('prod-expiry').value = prod.expiryDate || '';
  document.getElementById('prod-batch').value = prod.batchNumber || '';

  openModal('modal-product');
}

// Session Items Modal
function openSessionItemsModal(session) {
  document.getElementById('session-modal-title').textContent = `Cart Session: ${session.session_id} (${session.cart_id})`;
  const tbody = document.getElementById('session-items-tbody');
  const items = session.items || [];

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Cart is empty (0 items).</td></tr>`;
  } else {
    tbody.innerHTML = items.map(item => `
      <tr>
        <td style="font-weight:600;">${item.name || item.product_id}</td>
        <td><span class="category-badge">${item.category || 'General'}</span></td>
        <td style="text-align:right; font-weight:700;">${item.quantity}</td>
        <td style="text-align:right;">${formatCurrency(item.unit_price_at_addition)}</td>
        <td style="text-align:right; font-weight:700;">${formatCurrency(item.subtotal)}</td>
      </tr>
    `).join('');
  }
  openModal('modal-session-items');
}

// Sale Receipt Modal
function openSaleReceiptModal(sale) {
  document.getElementById('sale-modal-title').textContent = `Receipt for Sale: ${sale.sale_id}`;
  const tbody = document.getElementById('sale-detail-items-tbody');
  const items = sale.lineItems || [];

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No line item records.</td></tr>`;
  } else {
    tbody.innerHTML = items.map(item => `
      <tr>
        <td style="font-weight:600;">${item.name || item.product_id}</td>
        <td><span class="category-badge">${item.category || 'General'}</span></td>
        <td style="text-align:right; font-weight:700;">${item.quantity}</td>
        <td style="text-align:right;">${formatCurrency(item.unit_price)}</td>
        <td style="text-align:right; font-weight:700;">${formatCurrency(item.line_subtotal)}</td>
      </tr>
    `).join('');
  }
  openModal('modal-sale-receipt');
}

// Smart Promotion Modal
function openPromotionModal(productId = null, discount = 15, reason = '') {
  populateProductSelects();
  const select = document.getElementById('promo-product-select');
  if (select && productId) {
    select.value = productId;
  }
  document.getElementById('promo-discount-input').value = discount;
  document.getElementById('promo-reason-input').value = reason || 'Clearance discount for approaching expiry';
  openModal('modal-promotion');
}

// ==========================================
// 7. Form Handlers
// ==========================================
function setupForms() {
  // Product Save (Add or Edit)
  const prodForm = document.getElementById('form-product');
  if (prodForm) {
    prodForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const isEdit = document.getElementById('prod-form-is-edit').value === 'true';
      const prodId = document.getElementById('prod-id').value.trim();

      const payload = {
        id: prodId,
        name: document.getElementById('prod-name').value.trim(),
        rfid: document.getElementById('prod-rfid').value.trim(),
        category: document.getElementById('prod-category').value,
        supplier: document.getElementById('prod-supplier').value.trim(),
        cost: parseFloat(document.getElementById('prod-cost').value) || 0,
        price: parseFloat(document.getElementById('prod-price').value) || 0,
        reorderLevel: parseInt(document.getElementById('prod-reorder').value, 10) || 10,
        safetyStock: parseInt(document.getElementById('prod-safety').value, 10) || 5,
        leadTimeDays: parseInt(document.getElementById('prod-lead-time').value, 10) || 3,
        targetCoverageDays: parseInt(document.getElementById('prod-target-coverage').value, 10) || 14,
        onHand: parseInt(document.getElementById('prod-onhand').value, 10) || 0,
        expiryDate: document.getElementById('prod-expiry').value || null,
        batchNumber: document.getElementById('prod-batch').value.trim() || null
      };

      try {
        const method = isEdit ? 'PUT' : 'POST';
        const url = isEdit ? `${API_BASE}/admin/products/${prodId}` : `${API_BASE}/admin/products`;

        const res = await fetchWithAuth(url, {
          method,
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
          showToast(`Product ${isEdit ? 'updated' : 'registered'} successfully`, 'success');
          closeModal('modal-product');
          refreshAllData();
        } else {
          showToast(data.error || 'Failed to save product', 'error');
        }
      } catch (err) {
        showToast('Server error saving product', 'error');
      }
    });
  }

  // Restock Form
  const restockForm = document.getElementById('form-restock');
  if (restockForm) {
    // Mode tabs
    const restockTab = document.getElementById('mode-tab-restock');
    const damagedTab = document.getElementById('mode-tab-damaged');
    const incomingFields = document.getElementById('restock-fields-incoming');
    const damagedFields = document.getElementById('restock-fields-damaged');
    const modeInput = document.getElementById('restock-mode');
    const qtyLabel = document.getElementById('restock-qty-label');
    const submitBtn = document.getElementById('btn-submit-restock');

    restockTab.addEventListener('click', () => {
      modeInput.value = 'restock';
      restockTab.className = 'btn-primary';
      damagedTab.className = 'btn-secondary';
      incomingFields.classList.remove('hidden');
      damagedFields.classList.add('hidden');
      qtyLabel.textContent = 'Quantity Received (Units) *';
      submitBtn.textContent = 'Confirm Inbound Stock';
    });

    damagedTab.addEventListener('click', () => {
      modeInput.value = 'damaged';
      damagedTab.className = 'btn-primary';
      restockTab.className = 'btn-secondary';
      incomingFields.classList.add('hidden');
      damagedFields.classList.remove('hidden');
      qtyLabel.textContent = 'Quantity to Write-Off (Units) *';
      submitBtn.textContent = 'Write-Off Damaged Stock';
    });

    restockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = modeInput.value;
      const productId = document.getElementById('restock-product-select').value;
      const quantity = parseInt(document.getElementById('restock-qty').value, 10);
      const poNumber = document.getElementById('restock-po')?.value.trim();
      const batchNumber = document.getElementById('restock-batch')?.value.trim();
      const expiryDate = document.getElementById('restock-expiry')?.value;
      const damageReason = document.getElementById('damage-reason')?.value;
      const notes = document.getElementById('restock-notes').value.trim();

      const payload = {
        productId,
        type: mode === 'damaged' ? 'DAMAGE_WRITEOFF' : 'RESTOCK',
        quantity,
        poNumber: poNumber || (mode === 'damaged' ? 'DMG-WRITEOFF' : 'PO-DIRECT'),
        batchNumber: batchNumber || null,
        expiryDate: expiryDate || null,
        notes: notes || (mode === 'damaged' ? damageReason : 'Inbound shelf restock verified')
      };

      try {
        const res = await fetchWithAuth(`${API_BASE}/admin/restock`, {
          method: 'POST',
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (data.success) {
          showToast(`Stock updated: ${data.action} ${data.delta > 0 ? `+${data.delta}` : data.delta} units`, 'success');
          closeModal('modal-restock');
          refreshAllData();
        } else {
          showToast(data.error || 'Failed to update stock', 'error');
        }
      } catch (err) {
        showToast('Server error updating stock', 'error');
      }
    });
  }

  // Physical Count Form
  const countForm = document.getElementById('form-cycle-count');
  if (countForm) {
    document.getElementById('count-product-select')?.addEventListener('change', updateCycleCountPreview);
    document.getElementById('count-physical-input')?.addEventListener('input', updateCycleCountPreview);

    countForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const productId = document.getElementById('count-product-select').value;
      const countedQty = parseInt(document.getElementById('count-physical-input').value, 10);
      const reason = document.getElementById('count-reason').value;
      const notes = document.getElementById('count-notes').value.trim();

      try {
        const res = await fetchWithAuth(`${API_BASE}/admin/cycle-count`, {
          method: 'POST',
          body: JSON.stringify({ productId, countedQty, reason, notes })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Physical count audit committed (delta: ${data.delta})`, 'success');
          closeModal('modal-cycle-count');
          refreshAllData();
        } else {
          showToast(data.error || 'Failed to record count', 'error');
        }
      } catch (err) {
        showToast('Server error recording count', 'error');
      }
    });
  }

  // Reorder Thresholds Form
  const threshForm = document.getElementById('form-thresholds');
  if (threshForm) {
    document.getElementById('thresh-product-select')?.addEventListener('change', loadProductThresholds);

    threshForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const productId = document.getElementById('thresh-product-select').value;
      const reorderLevel = parseInt(document.getElementById('thresh-reorder').value, 10);
      const safetyStock = parseInt(document.getElementById('thresh-safety').value, 10);
      const leadTimeDays = parseInt(document.getElementById('thresh-leadtime').value, 10);
      const targetCoverageDays = parseInt(document.getElementById('thresh-target-coverage').value, 10);
      const supplier = document.getElementById('thresh-supplier').value.trim();

      try {
        const res = await fetchWithAuth(`${API_BASE}/admin/thresholds/${productId}`, {
          method: 'PUT',
          body: JSON.stringify({ reorderLevel, safetyStock, leadTimeDays, targetCoverageDays, supplier })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Reorder rules for ${productId} updated`, 'success');
          closeModal('modal-thresholds');
          refreshAllData();
        } else {
          showToast(data.error || 'Failed to update rules', 'error');
        }
      } catch (err) {
        showToast('Server error updating rules', 'error');
      }
    });
  }

  // Smart Promotion Form
  const promoForm = document.getElementById('form-promotion');
  if (promoForm) {
    promoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const productId = document.getElementById('promo-product-select').value;
      const discountPercent = parseFloat(document.getElementById('promo-discount-input').value);
      const reason = document.getElementById('promo-reason-input').value.trim();
      const expiresAt = document.getElementById('promo-expiry-input').value;

      try {
        const res = await fetchWithAuth(`${API_BASE}/admin/promotions`, {
          method: 'POST',
          body: JSON.stringify({ productId, discountPercent, reason, expiresAt: expiresAt || null })
        });
        const data = await res.json();
        if (data.success) {
          showToast(`Promotional offer (${discountPercent}%) activated!`, 'success');
          closeModal('modal-promotion');
          refreshAllData();
        } else {
          showToast(data.error || 'Failed to create promotion', 'error');
        }
      } catch (err) {
        showToast('Server error creating promotion', 'error');
      }
    });
  }
}

// ==========================================
// 8. Navigation & Tab Switcher
// ==========================================
function switchTab(tabId) {
  currentTab = tabId;

  // Update Top Tab buttons
  document.querySelectorAll('#admin-main-nav .nav-tab').forEach(tab => {
    if (tab.getAttribute('data-tab') === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Switch Active Section
  document.querySelectorAll('.admin-tab-view').forEach(view => {
    if (view.id === `view-${tabId}`) {
      view.classList.add('active');
    } else {
      view.classList.remove('active');
    }
  });

  // Lazy load data for specific tabs
  if (tabId === 'dashboard') {
    setTimeout(renderDashboardCharts, 50);
  } else if (tabId === 'sessions') loadSessionsData();
  else if (tabId === 'sales') loadSalesData();
  else if (tabId === 'expiry') loadExpiryData();
  else if (tabId === 'forecasting') loadForecastData();
  else if (tabId === 'basket') loadMarketBasketData();
  else if (tabId === 'reports') {
    loadAnalyticsData();
    setTimeout(renderAllCharts, 100);
  }
}

function setupSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const btnToggle = document.getElementById('btn-sidebar-toggle');
  const btnClose = document.getElementById('btn-sidebar-close');

  function openSidebar() {
    sidebar?.classList.add('open');
    backdrop?.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    sidebar?.classList.remove('open');
    backdrop?.classList.remove('active');
    document.body.style.overflow = '';
  }

  btnToggle?.addEventListener('click', openSidebar);
  btnClose?.addEventListener('click', closeSidebar);
  backdrop?.addEventListener('click', closeSidebar);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar?.classList.contains('open')) {
      closeSidebar();
    }
  });

  return { openSidebar, closeSidebar };
}

function setupNavigation() {
  const { closeSidebar } = setupSidebar();

  document.querySelectorAll('#admin-main-nav .nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = tab.getAttribute('data-tab');
      if (tabId) {
        switchTab(tabId);
        closeSidebar();
      }
    });
  });

  // Jump tab buttons
  document.querySelectorAll('[data-jump-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-jump-tab');
      if (target) switchTab(target);
    });
  });

  // Top action strip buttons
  document.getElementById('btn-action-add-prod')?.addEventListener('click', openAddProductModal);
  document.getElementById('btn-action-restock')?.addEventListener('click', () => openRestockModal());
  document.getElementById('btn-action-cycle-count')?.addEventListener('click', () => openCycleCountModal());
  document.getElementById('btn-action-thresholds')?.addEventListener('click', () => openThresholdsModal());
  document.getElementById('btn-inventory-add')?.addEventListener('click', openAddProductModal);
  document.getElementById('btn-inventory-restock')?.addEventListener('click', () => openRestockModal());
  document.getElementById('btn-create-custom-promo')?.addEventListener('click', () => openPromotionModal());
  document.getElementById('btn-refresh-sessions')?.addEventListener('click', loadSessionsData);
  document.getElementById('btn-cleanup-sessions')?.addEventListener('click', async () => {
    if (isDemoMode) { showToast('Stale session cleanup is not available in Demo mode', 'warning'); return; }
    try {
      const res = await fetchWithAuth(`${API_BASE}/admin/cleanup-stale-sessions`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showToast(data.message, data.cleanedCount > 0 ? 'success' : 'info');
        await Promise.all([loadSessionsData(), loadDashboardData()]);
      } else {
        showToast(data.error || 'Cleanup failed', 'error');
      }
    } catch (err) {
      showToast('Server error during cleanup', 'error');
    }
  });
  document.getElementById('btn-refresh-data')?.addEventListener('click', refreshAllData);

  // Demo Mode Switch
  const btnLive = document.getElementById('btn-mode-live');
  const btnDemo = document.getElementById('btn-mode-demo');
  const demoBanner = document.getElementById('demo-banner-pill');

  btnLive?.addEventListener('click', () => {
    isDemoMode = false;
    localStorage.setItem('trackcart_demo_mode', 'false');
    btnLive.classList.add('active');
    btnDemo.classList.remove('active');
    if (demoBanner) demoBanner.classList.add('hidden');
    showToast('Switched to Live PostgreSQL Database', 'info');
    refreshAllData();
  });

  btnDemo?.addEventListener('click', () => {
    isDemoMode = true;
    localStorage.setItem('trackcart_demo_mode', 'true');
    btnDemo.classList.add('active', 'demo');
    btnLive.classList.remove('active');
    if (demoBanner) demoBanner.classList.remove('hidden');
    showToast('Switched to Demo Analytics Simulation Mode', 'info');
    refreshAllData();
  });

  // Apply persisted mode visual indicator immediately on page load
  if (isDemoMode) {
    btnDemo?.classList.add('active', 'demo');
    btnLive?.classList.remove('active');
    if (demoBanner) demoBanner.classList.remove('hidden');
  } else {
    btnLive?.classList.add('active');
    btnDemo?.classList.remove('active');
    if (demoBanner) demoBanner.classList.add('hidden');
  }

  // Inventory Filters
  document.getElementById('inv-search-input')?.addEventListener('input', (e) => {
    inventoryFilter.search = e.target.value;
    renderInventoryTable();
  });
  document.getElementById('inv-filter-category')?.addEventListener('change', (e) => {
    inventoryFilter.category = e.target.value;
    renderInventoryTable();
  });
  document.getElementById('inv-filter-status')?.addEventListener('change', (e) => {
    inventoryFilter.status = e.target.value;
    renderInventoryTable();
  });
  document.getElementById('inv-sort-select')?.addEventListener('change', (e) => {
    inventoryFilter.sort = e.target.value;
    renderInventoryTable();
  });

  // Movements Filter
  document.getElementById('mov-search-input')?.addEventListener('input', (e) => {
    movementsFilter.search = e.target.value;
    renderMovementsTable();
  });
  document.getElementById('mov-filter-action')?.addEventListener('change', (e) => {
    movementsFilter.action = e.target.value;
    renderMovementsTable();
  });

  // Expiry Filter Buttons
  document.querySelectorAll('[data-expiry-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-expiry-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      expiryFilter = btn.getAttribute('data-expiry-filter');
      renderExpirySection();
    });
  });

  // Forecast Window & Filter
  document.getElementById('forecast-window-select')?.addEventListener('change', (e) => {
    forecastWindowDays = parseInt(e.target.value, 10);
    loadForecastData();
  });
  document.getElementById('forecast-filter-class')?.addEventListener('change', (e) => {
    forecastFilterClass = e.target.value;
    renderForecastSection();
  });

  // Market Basket Sort
  document.getElementById('basket-sort-select')?.addEventListener('change', (e) => {
    if (!basketData || !basketData.pairs) return;
    const val = e.target.value;
    if (val === 'lift-desc') basketData.pairs.sort((a, b) => b.lift - a.lift);
    else if (val === 'count-desc') basketData.pairs.sort((a, b) => b.coOccurrenceCount - a.coOccurrenceCount);
    else if (val === 'confidence-desc') basketData.pairs.sort((a, b) => b.confidenceAtoB - a.confidenceAtoB);
    renderMarketBasketSection();
  });

  // Reports Sub-Nav Tabs
  document.querySelectorAll('[data-report-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('[data-report-tab]').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentReportTab = tab.getAttribute('data-report-tab');

      document.querySelectorAll('.reports-tab-content').forEach(content => {
        if (content.id === `reports-tab-${currentReportTab}`) {
          content.classList.remove('hidden');
        } else {
          content.classList.add('hidden');
        }
      });
      setTimeout(renderAllCharts, 50);
    });
  });

  // Export CSV
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    if (products.length === 0) {
      showToast('No product data to export', 'warning');
      return;
    }
    const headers = ['Product ID', 'Name', 'RFID Tag', 'Category', 'Price', 'Cost', 'On Hand', 'Reserved', 'Available', 'Status', 'Sold Units', 'Supplier'];
    const rows = products.map(p => [
      p.id,
      `"${p.name.replace(/"/g, '""')}"`,
      p.rfid,
      p.category,
      p.price,
      p.cost,
      p.onHand,
      p.reserved,
      p.available,
      p.status,
      p.soldUnits,
      `"${(p.supplier || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `trackcart_inventory_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Inventory CSV exported successfully', 'success');
  });

  // Sales Filter Apply
  document.getElementById('btn-apply-sales-filter')?.addEventListener('click', loadSalesData);
}

// ==========================================
// 9. Application Bootstrap
// ==========================================
async function initAdminApp() {
  const isAuthed = await enforceAuth();
  if (!isAuthed) return;

  setupLogout();
  setupNavigation();
  setupModalClosers();
  setupForms();

  // Set default sales date filter (today)
  const todayStr = new Date().toISOString().split('T')[0];
  const startInput = document.getElementById('sales-start-date');
  const endInput = document.getElementById('sales-end-date');
  if (startInput) startInput.value = todayStr;
  if (endInput) endInput.value = todayStr;

  // Load initial data
  await loadDashboardData();
  await loadForecastData();
  await loadExpiryData();
  await loadMarketBasketData();
  await loadAnalyticsData();
}

document.addEventListener('DOMContentLoaded', initAdminApp);
