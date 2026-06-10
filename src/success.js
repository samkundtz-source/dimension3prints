/**
 * success.js — order-confirmation page behaviour.
 * External module (no inline scripts) so the site-wide CSP stays script-src 'self'.
 * Reads ?session_id, asks the worker for the order summary, fills the order
 * number and the "view in generator" deep link.
 */
(async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('session_id');
  if (!sessionId) return;
  try {
    const resp = await fetch('/api/order-info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await resp.json();
    if (data.orderId) {
      document.getElementById('order-id-val').textContent = data.orderId;
      document.getElementById('order-id-row').style.display = '';
    }
    if (data.tileCount > 1) {
      const row = document.getElementById('order-tiles-row');
      if (row) {
        document.getElementById('order-tiles-val').textContent =
          `${data.tileCount} connected (printed separately)`;
        row.style.display = '';
      }
    }
    if (data.lat && data.lng) {
      const p = new URLSearchParams({
        lat:      data.lat,
        lng:      data.lng,
        radius:   data.radius        ?? 1,
        scale:    data.verticalScale ?? 3,
        rotation: data.rotation      ?? 0,
        shape:    data.shape         || 'hexagon',
      });
      if (data.orderId) p.set('orderId', data.orderId);
      const btn = document.getElementById('view-generator-btn');
      btn.href = '/app.html?' + p.toString();
      btn.style.display = '';
    }
  } catch { /* page stays in its default state */ }
})();
