/**
 * Cloudflare Worker entry point.
 *
 * Handles the Stripe checkout API at /api/create-checkout and delegates
 * everything else to the static asset binding (env.ASSETS).
 */

const US_COUNTRIES = ['US'];
const CA_COUNTRIES = ['CA'];
const INTL_COUNTRIES = ['GB', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK', 'FI', 'IE', 'NZ'];

const SHIPPING_RATES = {
  US: [
    { type: 'fixed_amount', fixed_amount: { amount: 800,  currency: 'usd' }, display_name: 'Standard Shipping (USPS)',         delivery_estimate: { min: 5,  max: 10 } },
    { type: 'fixed_amount', fixed_amount: { amount: 1500, currency: 'usd' }, display_name: 'Express Shipping (USPS Priority)', delivery_estimate: { min: 2,  max: 4  } },
  ],
  CA: [
    { type: 'fixed_amount', fixed_amount: { amount: 1800, currency: 'usd' }, display_name: 'Standard Shipping to Canada',      delivery_estimate: { min: 7,  max: 14 } },
  ],
  INTL: [
    { type: 'fixed_amount', fixed_amount: { amount: 3000, currency: 'usd' }, display_name: 'International Shipping',           delivery_estimate: { min: 10, max: 21 } },
  ],
};

function getShippingForRegion(region) {
  if (region === 'CA')   return { countries: CA_COUNTRIES,   rates: SHIPPING_RATES.CA };
  if (region === 'INTL') return { countries: INTL_COUNTRIES, rates: SHIPPING_RATES.INTL };
  return { countries: US_COUNTRIES, rates: SHIPPING_RATES.US };
}

// Stripe expects application/x-www-form-urlencoded with bracketed nesting
function encodeStripeForm(obj, prefix = '', out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => encodeStripeForm(v, `${prefix}[${i}]`, out));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}[${k}]` : k;
      encodeStripeForm(v, key, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`);
  }
  return out;
}

/** Generate a short order ID like "C3D-A7K2" */
function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let id = '';
  const arr = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) id += chars[arr[i] % chars.length];
  return `C3D-${id}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleCreateCheckout(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { lat, lng, radius, verticalScale, elevation, terrainRelief,
          detailedBuildings, roadElevation, rotation, region } = body;
  if (lat == null || lng == null || radius == null) {
    return jsonResponse({ error: 'Missing location data' }, 400);
  }

  // Check order limits
  const settings = await getSettings(env);
  let paidCount = 0;
  try {
    const countResp = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const countData = await countResp.json();
    paidCount = (countData.data || []).filter(s => s.payment_status === 'paid').length;
  } catch { /* proceed anyway */ }

  const isPreOrder = paidCount >= settings.orderLimit;
  if (isPreOrder && !settings.preOrderEnabled) {
    return jsonResponse({ error: 'Orders are currently closed. Please check back later.' }, 400);
  }

  const orderId    = generateOrderId();
  const unitAmount = 2999; // $29.99
  const preOrderTag = isPreOrder ? ' [PRE-ORDER]' : '';
  const modelDesc  = `${orderId}${preOrderTag} — 3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x${terrainRelief ? ' | Terrain relief' : ''}`;
  const shipping   = getShippingForRegion(region || 'US');

  const shippingOptions = shipping.rates.map((r) => ({
    shipping_rate_data: {
      type:          r.type,
      fixed_amount:  r.fixed_amount,
      display_name:  r.display_name,
      delivery_estimate: {
        minimum: { unit: 'business_day', value: r.delivery_estimate.min },
        maximum: { unit: 'business_day', value: r.delivery_estimate.max },
      },
    },
  }));

  const origin = request.headers.get('origin') || new URL(request.url).origin;

  const payload = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name:        'Cities3ds — Custom 3D Map',
            description: modelDesc,
            images:      ['https://cities3ds.com/preview.png'],
          },
          unit_amount: unitAmount,
        },
        quantity: 1,
      },
    ],
    shipping_address_collection: { allowed_countries: shipping.countries },
    shipping_options: shippingOptions,
    metadata: {
      orderId,
      lat:               String(lat),
      lng:               String(lng),
      radius:            String(radius),
      verticalScale:     String(verticalScale),
      elevation:         String(elevation         || false),
      terrainRelief:     String(terrainRelief     || false),
      detailedBuildings: String(detailedBuildings || false),
      roadElevation:     String(roadElevation     || false),
      rotation:          String(rotation          || 0),
      region:            region || 'US',
      preOrder:          String(isPreOrder),
    },
    success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${origin}/app.html`,
  };

  const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encodeStripeForm(payload).join('&'),
  });

  let session;
  try {
    session = await stripeResp.json();
  } catch {
    const text = await stripeResp.text().catch(() => '');
    return jsonResponse({ error: `Stripe returned non-JSON (HTTP ${stripeResp.status}): ${text.slice(0, 200)}` }, 500);
  }

  if (!stripeResp.ok) {
    return jsonResponse({ error: session.error?.message || 'Stripe error' }, 500);
  }

  return jsonResponse({ url: session.url });
}

// ─── Public order info (just orderId — no sensitive data) ───────────────────

async function handleOrderInfo(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (!body.sessionId) return jsonResponse({ error: 'Missing sessionId' }, 400);

  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!resp.ok) return jsonResponse({ error: 'Session not found' }, 404);
  const session = await resp.json();

  return jsonResponse({
    orderId: session.metadata?.orderId || null,
  });
}

// ─── Admin endpoints ────────────────────────────────────────────────────────

// Brute-force protection: 5 failures per IP → 15-min lockout
const RATE_LIMIT_MAX  = 5;
const RATE_LIMIT_SECS = 15 * 60; // 15 minutes

async function checkRateLimit(env, ip) {
  if (!env.SETTINGS) return { blocked: false }; // KV not available — degrade gracefully
  const key = `ratelimit:${ip}`;
  let record;
  try {
    record = await env.SETTINGS.get(key, 'json');
  } catch {
    return { blocked: false };
  }
  if (!record) return { blocked: false, count: 0 };
  if (record.count >= RATE_LIMIT_MAX) {
    const elapsed = Math.floor(Date.now() / 1000) - record.ts;
    if (elapsed < RATE_LIMIT_SECS) {
      const retryAfter = RATE_LIMIT_SECS - elapsed;
      return { blocked: true, retryAfter };
    }
    // Window expired — clear it
    await env.SETTINGS.delete(key).catch(() => {});
    return { blocked: false, count: 0 };
  }
  return { blocked: false, count: record.count };
}

async function recordFailedAttempt(env, ip) {
  if (!env.SETTINGS) return;
  const key = `ratelimit:${ip}`;
  let record;
  try { record = await env.SETTINGS.get(key, 'json'); } catch { record = null; }
  const now = Math.floor(Date.now() / 1000);
  const newRecord = {
    count: (record?.count ?? 0) + 1,
    ts:    record?.ts ?? now, // keep original window start
  };
  await env.SETTINGS.put(key, JSON.stringify(newRecord), { expirationTtl: RATE_LIMIT_SECS });
}

async function clearRateLimit(env, ip) {
  if (!env.SETTINGS) return;
  await env.SETTINGS.delete(`ratelimit:${ip}`).catch(() => {});
}

function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

async function handleAdminVerify(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.ADMIN_PASSWORD)       return jsonResponse({ error: 'Admin password not configured' }, 500);

  const ip = getClientIP(request);

  // Check rate limit before even reading the body
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) {
    const mins = Math.ceil(rl.retryAfter / 60);
    return jsonResponse({ error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` }, 429);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password === env.ADMIN_PASSWORD) {
    await clearRateLimit(env, ip); // successful login clears lockout
    return jsonResponse({ success: true });
  }

  await recordFailedAttempt(env, ip);
  const remaining = RATE_LIMIT_MAX - (rl.count ?? 0) - 1;
  const hint = remaining > 0 ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)` : ' — you are now locked out for 15 minutes.';
  return jsonResponse({ error: `Invalid password${hint}` }, 401);
}

async function handleAdminOrders(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const limit = Math.min(body.limit || 50, 100);
  const params = new URLSearchParams({ limit: String(limit) });
  if (body.starting_after) params.set('starting_after', body.starting_after);

  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  let sessions;
  try { sessions = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe returned non-JSON (HTTP ${stripeResp.status})` }, 500); }

  if (!stripeResp.ok) {
    return jsonResponse({ error: sessions.error?.message || 'Stripe error' }, 500);
  }

  const orders = (sessions.data || [])
    .filter((s) => s.payment_status === 'paid')
    .map((s) => ({
      id:             s.id,
      orderId:        s.metadata?.orderId || s.id.slice(-6).toUpperCase(),
      paymentIntent:  s.payment_intent,
      created:        s.created,
      amount:         s.amount_total,
      currency:       s.currency,
      status:         s.metadata?.fulfillment_status || 'pending',
      email:          s.customer_details?.email || '',
      name:           s.customer_details?.name || s.shipping_details?.name || '',
      shipping:       s.shipping_details?.address ? {
        name:    s.shipping_details.name,
        line1:   s.shipping_details.address.line1,
        line2:   s.shipping_details.address.line2,
        city:    s.shipping_details.address.city,
        state:   s.shipping_details.address.state,
        postal:  s.shipping_details.address.postal_code,
        country: s.shipping_details.address.country,
      } : null,
      shippingRate: s.shipping_cost?.amount_total || 0,
      preOrder: s.metadata?.preOrder === 'true',
      model: {
        lat:               parseFloat(s.metadata?.lat)           || 0,
        lng:               parseFloat(s.metadata?.lng)           || 0,
        radius:            parseFloat(s.metadata?.radius)        || 1,
        verticalScale:     parseFloat(s.metadata?.verticalScale) || 3,
        elevation:         s.metadata?.elevation         === 'true',
        terrainRelief:     s.metadata?.terrainRelief     === 'true',
        detailedBuildings: s.metadata?.detailedBuildings === 'true',
        roadElevation:     s.metadata?.roadElevation     === 'true',
        rotation:          parseFloat(s.metadata?.rotation)      || 0,
      },
    }));

  return jsonResponse({
    orders,
    hasMore: sessions.has_more,
    lastId:  sessions.data?.length ? sessions.data[sessions.data.length - 1].id : null,
  });
}

async function handleAdminUpdateOrder(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const validStatuses = ['pending', 'printing', 'shipped', 'delivered'];
  if (!validStatuses.includes(body.status)) {
    return jsonResponse({ error: 'Invalid status' }, 400);
  }

  const formBody = encodeStripeForm({
    metadata: { fulfillment_status: body.status },
  }).join('&');

  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody,
  });

  let result;
  try { result = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe returned non-JSON (HTTP ${stripeResp.status})` }, 500); }

  if (!stripeResp.ok) {
    return jsonResponse({ error: result.error?.message || 'Stripe error' }, 500);
  }

  return jsonResponse({ success: true, status: body.status });
}

// ─── Settings (KV-backed) ──────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  orderLimit: 50,
  preOrderEnabled: true,
  preOrderMessage: 'Pre-order available — your print will ship after the initial batch is fulfilled. Estimated 3-4 weeks.',
};

async function getSettings(env) {
  if (!env.SETTINGS) return { ...DEFAULT_SETTINGS };
  try {
    const raw = await env.SETTINGS.get('shop_settings', 'json');
    return raw ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function handleGetSettings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const settings = await getSettings(env);
  return jsonResponse({ settings });
}

async function handleUpdateSettings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.SETTINGS) return jsonResponse({ error: 'KV namespace SETTINGS not bound' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const current = await getSettings(env);
  const updated = {
    orderLimit:      body.orderLimit      != null ? Math.max(0, parseInt(body.orderLimit, 10) || 0) : current.orderLimit,
    preOrderEnabled: body.preOrderEnabled != null ? !!body.preOrderEnabled : current.preOrderEnabled,
    preOrderMessage: body.preOrderMessage != null ? String(body.preOrderMessage).slice(0, 500) : current.preOrderMessage,
  };

  await env.SETTINGS.put('shop_settings', JSON.stringify(updated));
  return jsonResponse({ success: true, settings: updated });
}

// ─── Site content (KV-backed) ─────────────────────────────────────────────────

const DEFAULT_GALLERY = Array.from({ length: 6 }, () => ({ url: '', caption: '' }));

const DEFAULT_CONTENT = {
  heroHeadline: 'Your City,<br/><em>in 3D.</em>',
  heroSub: 'Pick any place on Earth. We generate a real 3D model with actual buildings, roads, and terrain — then print and ship it to you.',
  gallery: DEFAULT_GALLERY,
};

async function getContent(env) {
  if (!env.SETTINGS) return { ...DEFAULT_CONTENT };
  try {
    const raw = await env.SETTINGS.get('site_content', 'json');
    if (!raw) return { ...DEFAULT_CONTENT };
    return {
      heroHeadline: raw.heroHeadline ?? DEFAULT_CONTENT.heroHeadline,
      heroSub:      raw.heroSub      ?? DEFAULT_CONTENT.heroSub,
      gallery:      Array.isArray(raw.gallery)
                      ? raw.gallery.slice(0, 6).map(g => ({ url: String(g.url || ''), caption: String(g.caption || '') }))
                      : DEFAULT_GALLERY,
    };
  } catch {
    return { ...DEFAULT_CONTENT };
  }
}

// Public — landing page fetches this to hydrate gallery + hero text
async function handleGetContent(request, env) {
  const content = await getContent(env);
  return new Response(JSON.stringify({ content }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

// Admin — update site content
async function handleUpdateContent(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.SETTINGS) return jsonResponse({ error: 'KV namespace SETTINGS not bound' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const current = await getContent(env);
  const gallery = Array.isArray(body.gallery)
    ? body.gallery.slice(0, 6).map(g => ({
        url:     String(g.url     || '').slice(0, 500),
        caption: String(g.caption || '').slice(0, 100),
      }))
    : current.gallery;

  const updated = {
    heroHeadline: body.heroHeadline != null ? String(body.heroHeadline).slice(0, 200) : current.heroHeadline,
    heroSub:      body.heroSub      != null ? String(body.heroSub).slice(0, 400)      : current.heroSub,
    gallery,
  };

  await env.SETTINGS.put('site_content', JSON.stringify(updated));
  return jsonResponse({ success: true, content: updated });
}

// ─── MS Global Building Footprints (R2-backed) ────────────────────────────────
// Tiles are stored in R2 as `{zoom}/{x}/{y}.json` (GeoJSON FeatureCollection).
// The data pipeline script (scripts/process-ms-buildings.mjs) populates them.

function latLngToTile(lat, lng, zoom) {
  const n = 1 << zoom;
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const sinLat = Math.sin(latRad);
  const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

async function handleMsBuildings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  const { south, west, north, east } = body;
  if (south == null || west == null || north == null || east == null) {
    return jsonResponse({ error: 'Missing bbox' }, 400);
  }

  // Return empty gracefully when R2 bucket not yet set up
  if (!env.MS_BUILDINGS) {
    return jsonResponse({ features: [], note: 'MS_BUILDINGS R2 bucket not configured' });
  }

  const ZOOM = 12; // ~10km tiles — good for our max 10km capture radius
  const tl = latLngToTile(north, west, ZOOM);
  const br = latLngToTile(south, east, ZOOM);

  const tileKeys = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) {
      tileKeys.push(`${ZOOM}/${x}/${y}.json`);
    }
  }

  // Safety cap — shouldn't exceed 9 tiles for any normal capture radius
  if (tileKeys.length > 16) {
    return jsonResponse({ features: [], note: 'bbox too large' });
  }

  const allFeatures = [];
  await Promise.all(tileKeys.map(async key => {
    try {
      const obj = await env.MS_BUILDINGS.get(key);
      if (!obj) return;
      const data = await obj.json();
      if (Array.isArray(data?.features)) allFeatures.push(...data.features);
    } catch { /* tile missing or corrupt — skip silently */ }
  }));

  return jsonResponse({ features: allFeatures });
}

// Public endpoint — storefront checks order availability
async function handleOrderAvailability(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  const settings = await getSettings(env);

  // Count paid orders from Stripe
  let paidCount = 0;
  if (env.STRIPE_SECRET_KEY) {
    try {
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const data = await resp.json();
      paidCount = (data.data || []).filter(s => s.payment_status === 'paid').length;
    } catch { /* default to 0 */ }
  }

  const limitReached = paidCount >= settings.orderLimit;
  return jsonResponse({
    orderCount: paidCount,
    orderLimit: settings.orderLimit,
    limitReached,
    preOrderEnabled: settings.preOrderEnabled,
    preOrderMessage: limitReached ? settings.preOrderMessage : null,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/create-checkout':      return handleCreateCheckout(request, env);
      case '/api/order-info':           return handleOrderInfo(request, env);
      case '/api/admin-verify':         return handleAdminVerify(request, env);
      case '/api/admin-orders':         return handleAdminOrders(request, env);
      case '/api/admin-update-order':   return handleAdminUpdateOrder(request, env);
      case '/api/admin-settings':        return handleGetSettings(request, env);
      case '/api/admin-update-settings': return handleUpdateSettings(request, env);
      case '/api/order-availability':    return handleOrderAvailability(request, env);
      case '/api/content':               return handleGetContent(request, env);
      case '/api/admin-update-content':  return handleUpdateContent(request, env);
      case '/api/ms-buildings':          return handleMsBuildings(request, env);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};
