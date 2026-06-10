/**
 * admin.js — Cities3ds admin dashboard behaviour.
 *
 * External module (no inline <script>, no inline event handlers) so the
 * site-wide CSP can stay `script-src 'self'`. All dynamic rows use data-
 * attributes + delegated listeners; everything user-controlled is escaped
 * with escHtml before touching innerHTML.
 */

let adminToken = '';
let orders = [];
let activeFilter = 'all';
let sortOldestFirst = true; // oldest pending at top by default
let shopSettings = { orderLimit: 50, preOrderEnabled: true, preOrderMessage: '' };

const $ = (id) => document.getElementById(id);

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Login ───────────────────────────────────────────────────────────────────
$('login-btn').addEventListener('click', doLogin);
$('admin-pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('logout-btn').addEventListener('click', () => {
  adminToken = '';
  $('dashboard').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('admin-pw').value = '';
});

async function doLogin() {
  const pw = $('admin-pw').value.trim();
  if (!pw) return;
  $('login-error').textContent = '';
  try {
    const resp = await fetch('/api/admin-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await resp.json();
    if (data.success) {
      adminToken = data.token;
      $('login-screen').style.display = 'none';
      $('dashboard').style.display = 'block';
      loadOrders();
    } else {
      $('login-error').textContent = data.error || 'Invalid password';
      if (resp.status === 429) {
        $('admin-pw').disabled = true;
        $('login-btn').disabled = true;
      }
    }
  } catch {
    $('login-error').textContent = 'Connection error';
  }
}

// ─── Orders ─────────────────────────────────────────────────────────────────
async function loadOrders() {
  try {
    const resp = await fetch('/api/admin-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken, limit: 50 }),
    });
    const data = await resp.json();
    if (data.error) {
      const el = $('orders-list');
      el.innerHTML = '<div class="empty-state"><h2>Error</h2><p></p></div>';
      el.querySelector('p').textContent = data.error;
      return;
    }
    orders = data.orders || [];
    renderOrders();
    updateStats();
  } catch (err) {
    $('orders-list').innerHTML = '<div class="empty-state"><h2>Failed to load</h2><p></p></div>';
    $('orders-list').querySelector('p').textContent = err.message;
  }
}

$('status-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.status-tab');
  if (!tab) return;
  activeFilter = tab.dataset.filter;
  document.querySelectorAll('.status-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  renderOrders();
});

$('sort-btn').addEventListener('click', () => {
  sortOldestFirst = !sortOldestFirst;
  renderOrders();
});

function updateStats() {
  const counts = { all: orders.length, pending: 0, printing: 0, shipped: 0, delivered: 0 };
  for (const o of orders) {
    if (counts[o.status] !== undefined) counts[o.status]++;
  }
  $('stat-total').textContent = counts.all;
  $('stat-pending').textContent = counts.pending;
  $('stat-printing').textContent = counts.printing;
  $('stat-shipped').textContent = counts.shipped;
  const revenue = orders.reduce((sum, o) => sum + (o.amount || 0), 0) / 100;
  $('stat-revenue').textContent = '$' + revenue.toFixed(2);

  $('tab-all').textContent = counts.all;
  $('tab-pending').textContent = counts.pending;
  $('tab-printing').textContent = counts.printing;
  $('tab-shipped').textContent = counts.shipped;
  $('tab-delivered').textContent = counts.delivered;
}

function renderOrders() {
  const list = $('orders-list');
  const filtered = activeFilter === 'all' ? [...orders] : orders.filter(o => o.status === activeFilter);
  filtered.sort((a, b) => sortOldestFirst ? a.created - b.created : b.created - a.created);

  $('sort-btn').textContent = sortOldestFirst ? '↑ Oldest first' : '↓ Newest first';

  if (orders.length === 0) {
    list.innerHTML = '<div class="empty-state"><h2>No orders yet</h2><p>Orders will appear here once customers complete checkout.</p></div>';
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><h2>No ${escHtml(activeFilter)} orders</h2><p>Orders with "${escHtml(activeFilter)}" status will appear here.</p></div>`;
    return;
  }

  list.innerHTML = filtered.map((o) => {
    const date = new Date(o.created * 1000);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const amount = '$' + (o.amount / 100).toFixed(2);
    const orderId = o.orderId || ('C3D-' + o.id.slice(-4).toUpperCase());
    const shortId = o.id.slice(-8).toUpperCase();
    const sid = escHtml(o.id); // Stripe session id (alphanumeric + _), escaped anyway
    const addr = o.shipping;
    const addrStr = addr
      ? `${escHtml(addr.line1)}${addr.line2 ? ', ' + escHtml(addr.line2) : ''}, ${escHtml(addr.city)}, ${escHtml(addr.state)} ${escHtml(addr.postal)}, ${escHtml(addr.country)}`
      : 'No address';
    const m = o.model;
    const tiles = Number(m.tileCount) || 1;
    const safeId       = escHtml(orderId);
    const safeName     = escHtml(o.name);
    const safeEmail    = escHtml(o.email);
    const safeStatus   = escHtml(o.status);
    const safeShipName = escHtml(addr ? addr.name : '');

    return `
      <div class="order-card">
        <div class="order-header" data-sid="${sid}">
          <div class="order-left">
            <span class="order-id">${safeId}</span>
            <span class="order-num">#${shortId}</span>
            <span class="order-date">${dateStr}</span>
            <span style="font-size:12px;color:var(--text-muted)">${safeName || safeEmail}</span>
          </div>
          <div class="order-right">
            <span class="order-amount">${amount}</span>
            ${tiles > 1 ? `<span class="tiles-badge">${tiles} tiles</span>` : ''}
            ${o.preOrder ? '<span class="preorder-badge">Pre-order</span>' : ''}
            <span class="status-badge status-${safeStatus}">${safeStatus}</span>
          </div>
        </div>
        <div class="order-details" id="order-${sid}">
          <div class="detail-grid">
            <div class="detail-section">
              <h3>Customer</h3>
              <div class="detail-row"><span class="detail-label">Name: </span><span class="detail-val">${safeName || '—'}</span></div>
              <div class="detail-row"><span class="detail-label">Email: </span><span class="detail-val">${safeEmail || '—'}</span></div>
            </div>
            <div class="detail-section">
              <h3>Shipping</h3>
              <div class="detail-row"><span class="detail-val">${addr ? safeShipName : '—'}</span></div>
              <div class="detail-row"><span class="detail-val">${addrStr}</span></div>
            </div>
            <div class="detail-section">
              <h3>Model Parameters</h3>
              <div class="detail-row"><span class="detail-label">Location: </span><span class="detail-val">${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}</span></div>
              <div class="detail-row"><span class="detail-label">Radius: </span><span class="detail-val">${m.radius} km</span></div>
              <div class="detail-row"><span class="detail-label">Scale: </span><span class="detail-val">${m.verticalScale}x</span></div>
              <div class="detail-row"><span class="detail-label">Shape: </span><span class="detail-val">${escHtml(m.shape || 'hexagon')}</span></div>
              <div class="detail-row"><span class="detail-label">Connected tiles: </span><span class="detail-val">${tiles > 1 ? `${tiles} (separate prints)` : '1'}</span></div>
              <div class="detail-row"><span class="detail-label">Rotation: </span><span class="detail-val">${m.rotation ?? 0}°</span></div>
              <div class="detail-row"><span class="detail-label">Elevation: </span><span class="detail-val">${m.elevation ? 'Yes' : 'No'}</span></div>
              <div class="detail-row"><span class="detail-label">Terrain relief: </span><span class="detail-val">${m.terrainRelief ? 'Yes' : 'No'}</span></div>
            </div>
          </div>
          <div class="order-actions">
            <button class="btn-action primary btn-open-gen" data-sid="${sid}">Open in Generator</button>
            <select class="status-select" data-sid="${sid}">
              <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="printing" ${o.status === 'printing' ? 'selected' : ''}>Printing</option>
              <option value="shipped" ${o.status === 'shipped' ? 'selected' : ''}>Shipped</option>
              <option value="delivered" ${o.status === 'delivered' ? 'selected' : ''}>Delivered</option>
            </select>
          </div>
        </div>
      </div>`;
  }).join('');
}

// Delegated interactions — survive every re-render, no inline handlers needed.
$('orders-list').addEventListener('click', e => {
  const gen = e.target.closest('.btn-open-gen');
  if (gen) { openInGenerator(gen.dataset.sid); return; }
  const header = e.target.closest('.order-header');
  if (header) {
    const el = $('order-' + header.dataset.sid);
    if (el) el.classList.toggle('open');
  }
});
$('orders-list').addEventListener('change', e => {
  const sel = e.target.closest('.status-select');
  if (sel) updateStatus(sel.dataset.sid, sel.value);
});

function openInGenerator(sid) {
  const o = orders.find(o => o.id === sid);
  if (!o) return;
  const m = o.model;
  const orderId = o.orderId || ('C3D-' + o.id.slice(-4).toUpperCase());
  const params = new URLSearchParams({
    lat: m.lat, lng: m.lng, radius: m.radius,
    scale: m.verticalScale, elevation: m.elevation,
    terrainRelief: m.terrainRelief ?? false,
    shape: m.shape || 'hexagon',
    rotation: m.rotation ?? 0,
    admin: '1',
    orderId,
  });
  window.open('/app.html?' + params.toString(), '_blank');
}

async function updateStatus(sessionId, status) {
  try {
    const resp = await fetch('/api/admin-update-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken, sessionId, status }),
    });
    const data = await resp.json();
    if (data.success) {
      const o = orders.find(o => o.id === sessionId);
      if (o) o.status = status;
      renderOrders();
      updateStats();
    }
  } catch (err) {
    alert('Failed to update: ' + err.message);
  }
}

// ─── Page tabs ──────────────────────────────────────────────────────────────
document.querySelector('.page-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.page-tab');
  if (!tab) return;
  const page = tab.dataset.page;
  document.querySelectorAll('.page-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  document.querySelectorAll('.page-content').forEach(p => p.classList.remove('active'));
  $('page-' + page).classList.add('active');
  if (page === 'limits') loadSettings();
  if (page === 'frontpage') loadFrontPageContent();
});

// ─── Settings ───────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const resp = await fetch('/api/admin-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: adminToken }),
    });
    const data = await resp.json();
    if (data.settings) {
      shopSettings = data.settings;
      $('setting-order-limit').value = shopSettings.orderLimit;
      $('setting-preorder-enabled').checked = shopSettings.preOrderEnabled;
      $('setting-preorder-message').value = shopSettings.preOrderMessage;
    }
  } catch { /* defaults */ }
  updateLimitBar();
}

function updateLimitBar() {
  const count = orders.length;
  const limit = shopSettings.orderLimit || 1;
  const pct = Math.min(100, Math.round((count / limit) * 100));
  const fill = $('limit-bar-fill');
  fill.style.width = pct + '%';
  fill.style.background = pct >= 100 ? '#ff9800' : pct >= 80 ? '#ffc107' : '#66bb6a';
  $('limit-count-label').textContent = `${count} / ${shopSettings.orderLimit} orders`;
  $('limit-pct-label').textContent = pct + '%';
}

$('save-settings-btn').addEventListener('click', async () => {
  const btn = $('save-settings-btn');
  const status = $('save-status');
  btn.disabled = true;
  status.textContent = 'Saving...';
  status.style.color = 'var(--text-muted)';
  try {
    const resp = await fetch('/api/admin-update-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: adminToken,
        orderLimit: parseInt($('setting-order-limit').value, 10),
        preOrderEnabled: $('setting-preorder-enabled').checked,
        preOrderMessage: $('setting-preorder-message').value,
      }),
    });
    const data = await resp.json();
    if (data.success) {
      shopSettings = data.settings;
      status.textContent = 'Saved!';
      status.style.color = '#66bb6a';
      updateLimitBar();
    } else {
      status.textContent = 'Error: ' + (data.error || 'Unknown');
      status.style.color = '#ff6b6b';
    }
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
    status.style.color = '#ff6b6b';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; }, 3000);
});

// ─── Front Page content ─────────────────────────────────────────────────────
let fpContent = null;

// Must mirror the worker's DEFAULT_CONTENT so untouched defaults show as blank
// inputs ("use site default") rather than as custom overrides.
const DEFAULT_HEADLINE = 'Cities<br/>in 3D.';
const DEFAULT_SUB = 'Pick any place on Earth. We turn it into a 3D-printed model — buildings, roads, parks, terrain. Yours, delivered.';

function buildGallerySlots(gallery) {
  const container = $('gallery-slots');
  container.textContent = '';
  for (let i = 0; i < 6; i++) {
    const item = gallery[i] || { url: '', caption: '' };
    const slot = document.createElement('div');
    slot.style.marginBottom = '20px';
    slot.innerHTML = `
      <div class="gallery-slot-num">Photo ${i + 1}</div>
      <div class="gallery-slot">
        <div><input class="fp-input" id="gurl-${i}" placeholder="https://... or /images/photo.jpg" value="${escHtml(item.url)}" /></div>
        <div><input class="fp-caption" id="gcap-${i}" placeholder="Caption (optional)" value="${escHtml(item.caption)}" /></div>
      </div>`;
    container.appendChild(slot);
    slot.querySelector(`#gurl-${i}`).addEventListener('input', updateGalleryPreview);
  }
  updateGalleryPreview();
}

function updateGalleryPreview() {
  const urls = Array.from({ length: 6 }, (_, i) => $('gurl-' + i)?.value || '');
  const hasAny = urls.some(u => u.trim());
  const previewCard = $('gallery-preview-card');
  const previewGrid = $('gallery-preview-grid');
  previewCard.style.display = hasAny ? '' : 'none';
  previewGrid.textContent = '';
  urls.forEach((url, i) => {
    if (url.trim()) {
      const img = document.createElement('img');
      img.className = 'preview-thumb';
      img.alt = `Photo ${i + 1}`;
      img.src = url.trim();
      img.addEventListener('error', () => {
        img.style.outline = '1px solid #ff6b6b';
        img.alt = '⚠ Not found';
      });
      previewGrid.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'preview-thumb';
      ph.style.cssText = 'display:flex;align-items:center;justify-content:center';
      ph.textContent = 'empty';
      previewGrid.appendChild(ph);
    }
  });
}

async function loadFrontPageContent() {
  try {
    const resp = await fetch('/api/content');
    const data = await resp.json();
    fpContent = data.content || {};
  } catch {
    fpContent = {};
  }
  $('fp-headline').value = fpContent.heroHeadline === DEFAULT_HEADLINE ? '' : (fpContent.heroHeadline || '');
  $('fp-sub').value      = fpContent.heroSub === DEFAULT_SUB ? '' : (fpContent.heroSub || '');
  buildGallerySlots(fpContent.gallery || Array(6).fill({ url: '', caption: '' }));
}

$('save-frontpage-btn').addEventListener('click', async () => {
  const btn = $('save-frontpage-btn');
  const status = $('fp-save-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  status.style.color = 'var(--text-muted)';

  const gallery = Array.from({ length: 6 }, (_, i) => ({
    url:     ($('gurl-' + i)?.value || '').trim(),
    caption: ($('gcap-' + i)?.value || '').trim(),
  }));
  const heroHeadlineRaw = $('fp-headline').value.trim();
  const heroSubRaw      = $('fp-sub').value.trim();

  try {
    const resp = await fetch('/api/admin-update-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: adminToken,
        heroHeadline: heroHeadlineRaw || null,
        heroSub:      heroSubRaw      || null,
        gallery,
      }),
    });
    const data = await resp.json();
    if (data.success) {
      fpContent = data.content;
      status.textContent = '✓ Saved — changes live on the site';
      status.style.color = '#66bb6a';
    } else {
      status.textContent = 'Error: ' + (data.error || 'Unknown');
      status.style.color = '#ff6b6b';
    }
  } catch (err) {
    status.textContent = 'Failed: ' + err.message;
    status.style.color = '#ff6b6b';
  }
  btn.disabled = false;
  setTimeout(() => { status.textContent = ''; }, 4000);
});
