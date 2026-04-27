const US_COUNTRIES   = ['US'];
const CA_COUNTRIES   = ['CA'];
const INTL_COUNTRIES = ['GB', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK', 'FI', 'IE', 'NZ'];
const VALID_REGIONS  = new Set(['US', 'CA', 'INTL']);

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

function encodeStripeForm(obj, prefix = '', out = []) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => encodeStripeForm(v, `${prefix}[${i}]`, out));
  } else if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      encodeStripeForm(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else {
    out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`);
  }
  return out;
}

function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  const arr = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) id += chars[arr[i] % chars.length];
  return `C3D-${id}`;
}

function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options':        'DENY',
    'Referrer-Policy':        'strict-origin',
  };
}

function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...securityHeaders(), ...extra },
  });
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validateCheckoutBody(body) {
  const { lat, lng, radius, verticalScale, rotation, region,
          elevation, terrainRelief, detailedBuildings, roadElevation } = body;

  if (!isFiniteNum(lat) || lat < -90  || lat > 90)   return 'lat must be a number in [-90, 90]';
  if (!isFiniteNum(lng) || lng < -180 || lng > 180)  return 'lng must be a number in [-180, 180]';
  if (!isFiniteNum(radius) || radius < 0.1 || radius > 10) return 'radius must be 0.1–10 km';

  if (verticalScale !== undefined && (!isFiniteNum(verticalScale) || verticalScale < 1 || verticalScale > 5))
    return 'verticalScale must be 1–5';
  if (rotation !== undefined && (!isFiniteNum(rotation) || rotation < 0 || rotation >= 360))
    return 'rotation must be 0–359';

  for (const [name, val] of Object.entries({ elevation, terrainRelief, detailedBuildings, roadElevation })) {
    if (val !== undefined && typeof val !== 'boolean') return `${name} must be a boolean`;
  }

  if (region !== undefined && !VALID_REGIONS.has(region)) return 'region must be US, CA, or INTL';

  return null;
}

function validateBbox(body) {
  const { south, west, north, east } = body;
  if (!isFiniteNum(south) || south < -90  || south > 90)  return 'south must be [-90, 90]';
  if (!isFiniteNum(north) || north < -90  || north > 90)  return 'north must be [-90, 90]';
  if (!isFiniteNum(west)  || west  < -180 || west  > 180) return 'west must be [-180, 180]';
  if (!isFiniteNum(east)  || east  < -180 || east  > 180) return 'east must be [-180, 180]';
  if (south >= north) return 'south must be less than north';
  if (west  >= east)  return 'west must be less than east';
  return null;
}

function validateSessionId(id) {
  if (typeof id !== 'string')          return 'sessionId must be a string';
  if (id.length > 200)                 return 'sessionId too long';
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return 'sessionId has invalid format';
  return null;
}

const ADMIN_RL_MAX  = 5;
const ADMIN_RL_SECS = 15 * 60;

async function checkRateLimit(env, ip) {
  if (!env.SETTINGS) return { blocked: false };
  const key = `ratelimit:${ip}`;
  let record;
  try { record = await env.SETTINGS.get(key, 'json'); } catch { return { blocked: false }; }
  if (!record) return { blocked: false, count: 0 };
  if (record.count >= ADMIN_RL_MAX) {
    const elapsed = Math.floor(Date.now() / 1000) - record.ts;
    if (elapsed < ADMIN_RL_SECS) return { blocked: true, retryAfter: ADMIN_RL_SECS - elapsed };
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
  await env.SETTINGS.put(key, JSON.stringify({ count: (record?.count ?? 0) + 1, ts: record?.ts ?? now }), { expirationTtl: ADMIN_RL_SECS });
}

async function clearRateLimit(env, ip) {
  if (!env.SETTINGS) return;
  await env.SETTINGS.delete(`ratelimit:${ip}`).catch(() => {});
}

async function checkPublicRateLimit(env, ip, endpoint, maxRequests, windowSecs) {
  if (!env.SETTINGS) return { blocked: false };
  const key = `pub_rl:${endpoint}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  let record;
  try { record = await env.SETTINGS.get(key, 'json'); } catch { return { blocked: false }; }

  if (!record || now - record.windowStart >= windowSecs) {
    await env.SETTINGS.put(key, JSON.stringify({ count: 1, windowStart: now }), { expirationTtl: windowSecs * 2 }).catch(() => {});
    return { blocked: false };
  }
  if (record.count >= maxRequests) {
    return { blocked: true, retryAfter: Math.max(1, windowSecs - (now - record.windowStart)) };
  }
  await env.SETTINGS.put(key, JSON.stringify({ count: record.count + 1, windowStart: record.windowStart }), { expirationTtl: windowSecs * 2 }).catch(() => {});
  return { blocked: false };
}

const DEFAULT_SETTINGS = {
  orderLimit:      50,
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
                      ? raw.gallery.slice(0, 6).map(g => ({ url: String(g.url || '').slice(0, 500), caption: String(g.caption || '').slice(0, 100) }))
                      : DEFAULT_GALLERY,
    };
  } catch {
    return { ...DEFAULT_CONTENT };
  }
}

function latLngToTile(lat, lng, zoom) {
  const n      = 1 << zoom;
  const x      = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const sinLat = Math.sin(latRad);
  const y      = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

async function handleCreateCheckout(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const ip = getClientIP(request);
  const rl = await checkPublicRateLimit(env, ip, 'checkout', 10, 60);
  if (rl.blocked) return jsonResponse({ error: 'Too many requests.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Server configuration error' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const validationError = validateCheckoutBody(body);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  const {
    lat, lng, radius,
    verticalScale   = 3,
    rotation        = 0,
    region          = 'US',
    elevation       = false,
    terrainRelief   = false,
    detailedBuildings = false,
    roadElevation   = false,
  } = body;

  const settings = await getSettings(env);
  let paidCount = 0;
  try {
    const countResp = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const countData = await countResp.json();
    paidCount = (countData.data || []).filter(s => s.payment_status === 'paid').length;
  } catch {}

  const isPreOrder = paidCount >= settings.orderLimit;
  if (isPreOrder && !settings.preOrderEnabled) {
    return jsonResponse({ error: 'Orders are currently closed. Please check back later.' }, 400);
  }

  const orderId     = generateOrderId();
  const preOrderTag = isPreOrder ? ' [PRE-ORDER]' : '';
  const modelDesc   = `${orderId}${preOrderTag} — 3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x${terrainRelief ? ' | Terrain relief' : ''}`;
  const shipping    = getShippingForRegion(region);

  const shippingOptions = shipping.rates.map(r => ({
    shipping_rate_data: {
      type:              r.type,
      fixed_amount:      r.fixed_amount,
      display_name:      r.display_name,
      delivery_estimate: {
        minimum: { unit: 'business_day', value: r.delivery_estimate.min },
        maximum: { unit: 'business_day', value: r.delivery_estimate.max },
      },
    },
  }));

  const origin  = request.headers.get('origin') || new URL(request.url).origin;
  const payload = {
    payment_method_types: ['card'],
    mode:                 'payment',
    line_items: [{
      price_data: {
        currency:     'usd',
        product_data: { name: 'Cities3ds — Custom 3D Map', description: modelDesc, images: ['https://cities3ds.com/preview.png'] },
        unit_amount:  2999,
      },
      quantity: 1,
    }],
    shipping_address_collection: { allowed_countries: shipping.countries },
    shipping_options:            shippingOptions,
    metadata: {
      orderId,
      lat:               String(lat),
      lng:               String(lng),
      radius:            String(radius),
      verticalScale:     String(verticalScale),
      elevation:         String(elevation),
      terrainRelief:     String(terrainRelief),
      detailedBuildings: String(detailedBuildings),
      roadElevation:     String(roadElevation),
      rotation:          String(rotation),
      region,
      preOrder:          String(isPreOrder),
    },
    success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${origin}/app.html`,
  };

  const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:  'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    encodeStripeForm(payload).join('&'),
  });

  let session;
  try { session = await stripeResp.json(); }
  catch {
    const text = await stripeResp.text().catch(() => '');
    return jsonResponse({ error: `Stripe error (HTTP ${stripeResp.status}): ${text.slice(0, 200)}` }, 500);
  }

  if (!stripeResp.ok) return jsonResponse({ error: session.error?.message || 'Stripe error' }, 500);
  return jsonResponse({ url: session.url });
}

async function handleOrderInfo(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Not configured' }, 500);

  const ip = getClientIP(request);
  const rl = await checkPublicRateLimit(env, ip, 'order-info', 20, 60);
  if (rl.blocked) return jsonResponse({ error: 'Too many requests.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  const idError = validateSessionId(body.sessionId);
  if (idError) return jsonResponse({ error: idError }, 400);

  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!resp.ok) return jsonResponse({ error: 'Session not found' }, 404);
  const session = await resp.json();
  return jsonResponse({ orderId: session.metadata?.orderId || null });
}

const AVAIL_CACHE_TTL = 30;

async function getOrderAvailabilityCached(env) {
  if (!env.SETTINGS) return null;
  try {
    const cached = await env.SETTINGS.get('avail_cache', 'json');
    if (cached && Math.floor(Date.now() / 1000) - cached.ts < AVAIL_CACHE_TTL) {
      return cached.data;
    }
  } catch {}
  return null;
}

async function setOrderAvailabilityCache(env, data) {
  if (!env.SETTINGS) return;
  try {
    await env.SETTINGS.put('avail_cache', JSON.stringify({ ts: Math.floor(Date.now() / 1000), data }), { expirationTtl: AVAIL_CACHE_TTL * 2 });
  } catch {}
}

async function handleOrderAvailability(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const ip = getClientIP(request);
  const rl = await checkPublicRateLimit(env, ip, 'order-avail', 30, 60);
  if (rl.blocked) return jsonResponse({ error: 'Too many requests.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  const hit = await getOrderAvailabilityCached(env);
  if (hit) return jsonResponse(hit);

  const settings = await getSettings(env);
  let paidCount = 0;
  if (env.STRIPE_SECRET_KEY) {
    try {
      const resp = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const data = await resp.json();
      paidCount = (data.data || []).filter(s => s.payment_status === 'paid').length;
    } catch {}
  }

  const limitReached = paidCount >= settings.orderLimit;
  const result = {
    orderCount:      paidCount,
    orderLimit:      settings.orderLimit,
    limitReached,
    preOrderEnabled: settings.preOrderEnabled,
    preOrderMessage: limitReached ? settings.preOrderMessage : null,
  };

  await setOrderAvailabilityCache(env, result);
  return jsonResponse(result);
}

async function handleMsBuildings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const ip = getClientIP(request);
  const rl = await checkPublicRateLimit(env, ip, 'ms-buildings', 15, 60);
  if (rl.blocked) return jsonResponse({ error: 'Too many requests.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  const bboxError = validateBbox(body);
  if (bboxError) return jsonResponse({ error: bboxError }, 400);

  if (!env.MS_BUILDINGS) return jsonResponse({ features: [], note: 'MS_BUILDINGS R2 bucket not configured' });

  const ZOOM = 12;
  const tl   = latLngToTile(body.north, body.west, ZOOM);
  const br   = latLngToTile(body.south, body.east, ZOOM);

  const tileKeys = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) tileKeys.push(`${ZOOM}/${x}/${y}.json`);
  }
  if (tileKeys.length > 16) return jsonResponse({ features: [], note: 'bbox too large' });

  const allFeatures = [];
  await Promise.all(tileKeys.map(async key => {
    try {
      const obj = await env.MS_BUILDINGS.get(key);
      if (!obj) return;
      const data = await obj.json();
      if (Array.isArray(data?.features)) allFeatures.push(...data.features);
    } catch {}
  }));

  return jsonResponse({ features: allFeatures });
}

async function handleGetContent(request, env) {
  const ip = getClientIP(request);
  const rl = await checkPublicRateLimit(env, ip, 'content', 60, 60);
  if (rl.blocked) return jsonResponse({ error: 'Too many requests.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  const content = await getContent(env);
  return new Response(JSON.stringify({ content }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...securityHeaders() },
  });
}

async function handleAdminVerify(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.ADMIN_PASSWORD)       return jsonResponse({ error: 'Admin password not configured' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) {
    const mins = Math.ceil(rl.retryAfter / 60);
    return jsonResponse({ error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` }, 429, { 'Retry-After': String(rl.retryAfter) });
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string') return jsonResponse({ error: 'Bad request' }, 400);

  if (body.password === env.ADMIN_PASSWORD) {
    await clearRateLimit(env, ip);
    return jsonResponse({ success: true });
  }

  await recordFailedAttempt(env, ip);
  const remaining = ADMIN_RL_MAX - (rl.count ?? 0) - 1;
  const hint = remaining > 0 ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)` : ' — you are now locked out for 15 minutes.';
  return jsonResponse({ error: `Invalid password${hint}` }, 401);
}

async function handleAdminOrders(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const limit  = Math.min(typeof body.limit === 'number' ? Math.max(1, body.limit) : 50, 100);
  const params = new URLSearchParams({ limit: String(limit) });

  if (body.starting_after) {
    if (typeof body.starting_after !== 'string' || body.starting_after.length > 200 || !/^cs_[a-zA-Z0-9_]+$/.test(body.starting_after)) {
      return jsonResponse({ error: 'Invalid starting_after cursor' }, 400);
    }
    params.set('starting_after', body.starting_after);
  }

  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  let sessions;
  try { sessions = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe error (HTTP ${stripeResp.status})` }, 500); }
  if (!stripeResp.ok) return jsonResponse({ error: sessions.error?.message || 'Stripe error' }, 500);

  const orders = (sessions.data || [])
    .filter(s => s.payment_status === 'paid')
    .map(s => ({
      id:            s.id,
      orderId:       s.metadata?.orderId || s.id.slice(-6).toUpperCase(),
      paymentIntent: s.payment_intent,
      created:       s.created,
      amount:        s.amount_total,
      currency:      s.currency,
      status:        s.metadata?.fulfillment_status || 'pending',
      email:         s.customer_details?.email || '',
      name:          s.customer_details?.name  || s.shipping_details?.name || '',
      shipping:      s.shipping_details?.address ? {
        name:    s.shipping_details.name,
        line1:   s.shipping_details.address.line1,
        line2:   s.shipping_details.address.line2,
        city:    s.shipping_details.address.city,
        state:   s.shipping_details.address.state,
        postal:  s.shipping_details.address.postal_code,
        country: s.shipping_details.address.country,
      } : null,
      shippingRate: s.shipping_cost?.amount_total || 0,
      preOrder:     s.metadata?.preOrder === 'true',
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

  return jsonResponse({ orders, hasMore: sessions.has_more, lastId: sessions.data?.length ? sessions.data[sessions.data.length - 1].id : null });
}

async function handleAdminUpdateOrder(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const idError = validateSessionId(body.sessionId);
  if (idError) return jsonResponse({ error: idError }, 400);

  const VALID_STATUSES = new Set(['pending', 'printing', 'shipped', 'delivered']);
  if (!VALID_STATUSES.has(body.status)) return jsonResponse({ error: 'status must be: pending, printing, shipped, or delivered' }, 400);

  const stripeResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    encodeStripeForm({ metadata: { fulfillment_status: body.status } }).join('&'),
  });

  let result;
  try { result = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe error (HTTP ${stripeResp.status})` }, 500); }
  if (!stripeResp.ok) return jsonResponse({ error: result.error?.message || 'Stripe error' }, 500);
  return jsonResponse({ success: true, status: body.status });
}

async function handleGetSettings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  return jsonResponse({ settings: await getSettings(env) });
}

async function handleUpdateSettings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.SETTINGS) return jsonResponse({ error: 'KV namespace SETTINGS not bound' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const current = await getSettings(env);
  const updated = {
    orderLimit:      body.orderLimit      != null ? Math.max(0, parseInt(body.orderLimit, 10) || 0) : current.orderLimit,
    preOrderEnabled: body.preOrderEnabled != null ? !!body.preOrderEnabled : current.preOrderEnabled,
    preOrderMessage: body.preOrderMessage != null ? String(body.preOrderMessage).slice(0, 500)       : current.preOrderMessage,
  };

  await env.SETTINGS.put('shop_settings', JSON.stringify(updated));
  return jsonResponse({ success: true, settings: updated });
}

async function handleUpdateContent(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.SETTINGS) return jsonResponse({ error: 'KV namespace SETTINGS not bound' }, 500);

  const ip = getClientIP(request);
  const rl = await checkRateLimit(env, ip);
  if (rl.blocked) return jsonResponse({ error: 'Too many failed attempts. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const current = await getContent(env);
  const gallery = Array.isArray(body.gallery)
    ? body.gallery.slice(0, 6).map(g => ({ url: String(g.url || '').slice(0, 500), caption: String(g.caption || '').slice(0, 100) }))
    : current.gallery;

  const updated = {
    heroHeadline: body.heroHeadline != null ? String(body.heroHeadline).slice(0, 200) : current.heroHeadline,
    heroSub:      body.heroSub      != null ? String(body.heroSub).slice(0, 400)      : current.heroSub,
    gallery,
  };

  await env.SETTINGS.put('site_content', JSON.stringify(updated));
  return jsonResponse({ success: true, content: updated });
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/create-checkout':       return handleCreateCheckout(request, env);
      case '/api/order-info':            return handleOrderInfo(request, env);
      case '/api/order-availability':    return handleOrderAvailability(request, env);
      case '/api/ms-buildings':          return handleMsBuildings(request, env);
      case '/api/content':               return handleGetContent(request, env);
      case '/api/admin-verify':          return handleAdminVerify(request, env);
      case '/api/admin-orders':          return handleAdminOrders(request, env);
      case '/api/admin-update-order':    return handleAdminUpdateOrder(request, env);
      case '/api/admin-settings':        return handleGetSettings(request, env);
      case '/api/admin-update-settings': return handleUpdateSettings(request, env);
      case '/api/admin-update-content':  return handleUpdateContent(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
