/**
 * Cloudflare Worker — Cities3ds API
 *
 * Handles all /api/* routes; everything else is served by the static-asset binding.
 *
 * Security hardening (OWASP alignment):
 *   • Rate limiting  — admin endpoints: brute-force lockout (5 failures → 15-min block)
 *                    — public endpoints: fixed-window counter per IP (per-route limits)
 *   • Input validation — all user-supplied values are type-checked, range-clamped,
 *                        and rejected with a clear 400 before any downstream call
 *   • API keys       — all secrets live exclusively in env.* (Cloudflare secrets);
 *                        none are hard-coded or returned to the client
 *   • Security headers — every response carries X-Content-Type-Options, X-Frame-Options,
 *                        and Referrer-Policy
 *   • 429 responses  — always include a Retry-After header
 */

// ─── Shipping configuration ────────────────────────────────────────────────────

const US_COUNTRIES   = ['US'];
const CA_COUNTRIES   = ['CA'];
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

// Whitelisted region codes — validated against this set before use.
const VALID_REGIONS = new Set(['US', 'CA', 'INTL']);

function getShippingForRegion(region) {
  if (region === 'CA')   return { countries: CA_COUNTRIES,   rates: SHIPPING_RATES.CA };
  if (region === 'INTL') return { countries: INTL_COUNTRIES, rates: SHIPPING_RATES.INTL };
  return { countries: US_COUNTRIES, rates: SHIPPING_RATES.US };
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Stripe expects application/x-www-form-urlencoded with bracketed nesting. */
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

/** Generate a short order ID like "C3D-A7K2" (crypto-random, no ambiguous chars). */
function generateOrderId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let id = '';
  const arr = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) id += chars[arr[i] % chars.length];
  return `C3D-${id}`;
}

/** Extract the real client IP from Cloudflare headers. */
function getClientIP(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ||
    'unknown'
  );
}

// ─── Security headers ──────────────────────────────────────────────────────────

/**
 * Standard security headers applied to every API response.
 * These are separate from the CSP in app.html (which protects the HTML page);
 * these apply to JSON API responses only.
 */
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',      // Prevent MIME-type sniffing
    'X-Frame-Options':        'DENY',          // Prevent framing of API responses
    'Referrer-Policy':        'strict-origin', // Limit referrer leakage from API links
  };
}

/**
 * Build a JSON response with security headers baked in.
 *
 * @param {object} body          Value to JSON-serialize
 * @param {number} [status=200]  HTTP status code
 * @param {object} [extra={}]    Additional headers (e.g. Retry-After)
 */
function jsonResponse(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...securityHeaders(),
      ...extra,
    },
  });
}

// ─── Input validation ──────────────────────────────────────────────────────────

/** True iff v is a finite IEEE-754 number (rejects NaN, ±Infinity, strings, etc.). */
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate the body of a /api/create-checkout request.
 * Returns null on success, or a human-readable error string on failure.
 *
 * Geographic bounds are enforced here so no invalid coordinates ever reach
 * Stripe (preventing potential metadata injection via lat.toFixed crashes).
 */
function validateCheckoutBody(body) {
  const { lat, lng, radius, verticalScale, rotation, region,
          elevation, terrainRelief, detailedBuildings, roadElevation } = body;

  // ── Required geographic coordinates ──
  if (!isFiniteNum(lat) || lat < -90   || lat > 90)    return 'lat must be a number in [-90, 90]';
  if (!isFiniteNum(lng) || lng < -180  || lng > 180)   return 'lng must be a number in [-180, 180]';

  // ── Capture radius — must be within the slider range (0.5–10 km) ──
  // The server enforces the same ceiling as the admin slider so this
  // cannot be widened by a crafted request.
  if (!isFiniteNum(radius) || radius < 0.1 || radius > 10) {
    return 'radius must be a number in [0.1, 10] km';
  }

  // ── Optional numeric settings ──
  if (verticalScale !== undefined && (!isFiniteNum(verticalScale) || verticalScale < 1 || verticalScale > 5)) {
    return 'verticalScale must be a number in [1, 5]';
  }
  if (rotation !== undefined && (!isFiniteNum(rotation) || rotation < 0 || rotation >= 360)) {
    return 'rotation must be a number in [0, 360)';
  }

  // ── Optional boolean flags — reject any non-boolean value ──
  const boolFields = { elevation, terrainRelief, detailedBuildings, roadElevation };
  for (const [name, val] of Object.entries(boolFields)) {
    if (val !== undefined && typeof val !== 'boolean') {
      return `${name} must be a boolean`;
    }
  }

  // ── Region — strict whitelist; no arbitrary strings reach Stripe metadata ──
  if (region !== undefined && !VALID_REGIONS.has(region)) {
    return 'region must be "US", "CA", or "INTL"';
  }

  return null; // all checks passed
}

/**
 * Validate a bounding-box body ({ south, west, north, east }).
 * Returns null on success, or an error string.
 *
 * Rejects NaN/Infinity and logically impossible boxes (south ≥ north, etc.)
 * to prevent degenerate tile lookups in handleMsBuildings.
 */
function validateBbox(body) {
  const { south, west, north, east } = body;
  if (!isFiniteNum(south) || south < -90  || south > 90)  return 'south must be a number in [-90, 90]';
  if (!isFiniteNum(north) || north < -90  || north > 90)  return 'north must be a number in [-90, 90]';
  if (!isFiniteNum(west)  || west  < -180 || west  > 180) return 'west must be a number in [-180, 180]';
  if (!isFiniteNum(east)  || east  < -180 || east  > 180) return 'east must be a number in [-180, 180]';
  if (south >= north) return 'south must be less than north';
  if (west  >= east)  return 'west must be less than east';
  return null;
}

/**
 * Validate a Stripe checkout session ID before embedding it in a URL path.
 *
 * Stripe session IDs always begin with "cs_" followed by alphanumerics/underscores.
 * Rejecting anything else prevents path-traversal or injection into the Stripe URL.
 */
function validateSessionId(id) {
  if (typeof id !== 'string')          return 'sessionId must be a string';
  if (id.length > 200)                 return 'sessionId too long';
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) return 'sessionId has invalid format';
  return null;
}

// ─── Admin brute-force rate limiter ───────────────────────────────────────────
// 5 failures from the same IP → 15-minute lockout stored in KV.

const ADMIN_RL_MAX  = 5;
const ADMIN_RL_SECS = 15 * 60; // 15 minutes

async function checkRateLimit(env, ip) {
  if (!env.SETTINGS) return { blocked: false };
  const key = `ratelimit:${ip}`;
  let record;
  try { record = await env.SETTINGS.get(key, 'json'); } catch { return { blocked: false }; }
  if (!record) return { blocked: false, count: 0 };
  if (record.count >= ADMIN_RL_MAX) {
    const elapsed = Math.floor(Date.now() / 1000) - record.ts;
    if (elapsed < ADMIN_RL_SECS) {
      return { blocked: true, retryAfter: ADMIN_RL_SECS - elapsed };
    }
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
  const newRecord = { count: (record?.count ?? 0) + 1, ts: record?.ts ?? now };
  await env.SETTINGS.put(key, JSON.stringify(newRecord), { expirationTtl: ADMIN_RL_SECS });
}

async function clearRateLimit(env, ip) {
  if (!env.SETTINGS) return;
  await env.SETTINGS.delete(`ratelimit:${ip}`).catch(() => {});
}

// ─── Public endpoint rate limiter ─────────────────────────────────────────────
//
// Lighter than the admin brute-force limiter — uses a fixed sliding window.
// Each public endpoint gets its own per-IP counter in KV with an auto-expiring TTL.
//
// Limits (chosen to allow legitimate use while blocking automated abuse):
//   checkout       —  10 req / 60 s   (ordering is slow; 10 is very generous)
//   order-info     —  20 req / 60 s
//   order-avail    —  30 req / 60 s   (polled by the storefront)
//   ms-buildings   —  15 req / 60 s
//   content        —  60 req / 60 s   (static-ish; cached 60 s anyway)

/**
 * Fixed-window public rate limiter backed by KV.
 *
 * @param {object} env            Cloudflare bindings
 * @param {string} ip             Client IP address
 * @param {string} endpoint       Short identifier used in the KV key (e.g. 'checkout')
 * @param {number} maxRequests    Max requests permitted per window
 * @param {number} windowSecs     Window duration in seconds
 * @returns {{ blocked: boolean, retryAfter?: number }}
 */
async function checkPublicRateLimit(env, ip, endpoint, maxRequests, windowSecs) {
  // Degrade gracefully: if KV isn't available (e.g. local dev) allow the request.
  if (!env.SETTINGS) return { blocked: false };

  const key = `pub_rl:${endpoint}:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  let record;
  try {
    record = await env.SETTINGS.get(key, 'json');
  } catch {
    return { blocked: false }; // KV read error — fail open
  }

  // New window or expired window — reset counter.
  if (!record || now - record.windowStart >= windowSecs) {
    const fresh = { count: 1, windowStart: now };
    // TTL is 2× the window so the key expires well after the window closes.
    await env.SETTINGS.put(key, JSON.stringify(fresh), { expirationTtl: windowSecs * 2 })
      .catch(() => {}); // non-fatal if the write fails
    return { blocked: false };
  }

  if (record.count >= maxRequests) {
    const retryAfter = Math.max(1, windowSecs - (now - record.windowStart));
    return { blocked: true, retryAfter };
  }

  // Increment within current window.
  const updated = { count: record.count + 1, windowStart: record.windowStart };
  await env.SETTINGS.put(key, JSON.stringify(updated), { expirationTtl: windowSecs * 2 })
    .catch(() => {});
  return { blocked: false };
}

// ─── Settings (KV-backed) ──────────────────────────────────────────────────────

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

// ─── Site content (KV-backed) ──────────────────────────────────────────────────

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
                      ? raw.gallery.slice(0, 6).map(g => ({
                          url:     String(g.url     || '').slice(0, 500),
                          caption: String(g.caption || '').slice(0, 100),
                        }))
                      : DEFAULT_GALLERY,
    };
  } catch {
    return { ...DEFAULT_CONTENT };
  }
}

// ─── Tile math for MS Buildings ───────────────────────────────────────────────

function latLngToTile(lat, lng, zoom) {
  const n      = 1 << zoom;
  const x      = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const sinLat = Math.sin(latRad);
  const y      = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n);
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

// ─── Public API handlers ───────────────────────────────────────────────────────

async function handleCreateCheckout(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // ── Rate limit: 10 checkout attempts per IP per 60 s ──
  const ip = getClientIP(request);
  const rl  = await checkPublicRateLimit(env, ip, 'checkout', 10, 60);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many requests. Please wait before trying again.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ error: 'Server configuration error' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  // ── Strict input validation — all fields checked before they touch any API ──
  const validationError = validateCheckoutBody(body);
  if (validationError) return jsonResponse({ error: validationError }, 400);

  // Destructure only after validation passes — values are now guaranteed safe.
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

  // ── Check order limits ──
  const settings = await getSettings(env);
  let paidCount = 0;
  try {
    const countResp = await fetch('https://api.stripe.com/v1/checkout/sessions?limit=100', {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    const countData = await countResp.json();
    paidCount = (countData.data || []).filter(s => s.payment_status === 'paid').length;
  } catch { /* proceed anyway — Stripe count is advisory */ }

  const isPreOrder = paidCount >= settings.orderLimit;
  if (isPreOrder && !settings.preOrderEnabled) {
    return jsonResponse({ error: 'Orders are currently closed. Please check back later.' }, 400);
  }

  const orderId     = generateOrderId();
  const preOrderTag = isPreOrder ? ' [PRE-ORDER]' : '';
  // lat/lng/radius are all validated finite numbers here — .toFixed() is safe.
  const modelDesc = `${orderId}${preOrderTag} — 3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x${terrainRelief ? ' | Terrain relief' : ''}`;
  const shipping  = getShippingForRegion(region);

  const shippingOptions = shipping.rates.map((r) => ({
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

  const origin = request.headers.get('origin') || new URL(request.url).origin;

  const payload = {
    payment_method_types: ['card'],
    mode:                 'payment',
    line_items: [{
      price_data: {
        currency:     'usd',
        product_data: {
          name:        'Cities3ds — Custom 3D Map',
          description: modelDesc,
          images:      ['https://cities3ds.com/preview.png'],
        },
        unit_amount: 2999, // $29.99 — fixed server-side, never from client
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
    headers: {
      // STRIPE_SECRET_KEY lives only in env — never exposed to the client
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
    return jsonResponse(
      { error: `Stripe returned non-JSON (HTTP ${stripeResp.status}): ${text.slice(0, 200)}` },
      500,
    );
  }

  if (!stripeResp.ok) {
    return jsonResponse({ error: session.error?.message || 'Stripe error' }, 500);
  }

  return jsonResponse({ url: session.url });
}

// ── Public order info — just the orderId, no sensitive data ──────────────────

async function handleOrderInfo(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Not configured' }, 500);

  // ── Rate limit: 20 req / 60 s per IP ──
  const ip = getClientIP(request);
  const rl  = await checkPublicRateLimit(env, ip, 'order-info', 20, 60);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many requests. Please wait.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  // ── Validate sessionId format before embedding in a URL path ──
  const idError = validateSessionId(body.sessionId);
  if (idError) return jsonResponse({ error: idError }, 400);

  const resp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );
  if (!resp.ok) return jsonResponse({ error: 'Session not found' }, 404);
  const session = await resp.json();

  // Return only the non-sensitive orderId — no PII, no payment data.
  return jsonResponse({ orderId: session.metadata?.orderId || null });
}

// ── Order availability — polled by the storefront ────────────────────────────

async function handleOrderAvailability(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // ── Rate limit: 30 req / 60 s per IP ──
  const ip = getClientIP(request);
  const rl  = await checkPublicRateLimit(env, ip, 'order-avail', 30, 60);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many requests. Please wait.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  const settings = await getSettings(env);

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
    orderCount:      paidCount,
    orderLimit:      settings.orderLimit,
    limitReached,
    preOrderEnabled: settings.preOrderEnabled,
    preOrderMessage: limitReached ? settings.preOrderMessage : null,
  });
}

// ── MS Global Building Footprints (R2-backed) ─────────────────────────────────

async function handleMsBuildings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  // ── Rate limit: 15 req / 60 s per IP ──
  const ip = getClientIP(request);
  const rl  = await checkPublicRateLimit(env, ip, 'ms-buildings', 15, 60);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many requests. Please wait.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  // ── Validate bbox — rejects NaN, Infinity, inverted boxes ──
  const bboxError = validateBbox(body);
  if (bboxError) return jsonResponse({ error: bboxError }, 400);

  if (!env.MS_BUILDINGS) {
    return jsonResponse({ features: [], note: 'MS_BUILDINGS R2 bucket not configured' });
  }

  const ZOOM = 12; // ~10 km tiles
  const tl = latLngToTile(body.north, body.west, ZOOM);
  const br = latLngToTile(body.south, body.east, ZOOM);

  const tileKeys = [];
  for (let x = tl.x; x <= br.x; x++) {
    for (let y = tl.y; y <= br.y; y++) {
      tileKeys.push(`${ZOOM}/${x}/${y}.json`);
    }
  }

  // Safety cap — validated bbox should never exceed ~9 tiles for ≤10 km radius.
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
    } catch { /* tile missing or corrupt — skip */ }
  }));

  return jsonResponse({ features: allFeatures });
}

// ── Public site content ───────────────────────────────────────────────────────

async function handleGetContent(request, env) {
  // ── Rate limit: 60 req / 60 s per IP — content is cached for 60 s anyway ──
  const ip = getClientIP(request);
  const rl  = await checkPublicRateLimit(env, ip, 'content', 60, 60);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many requests. Please wait.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  const content = await getContent(env);
  return new Response(JSON.stringify({ content }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
      ...securityHeaders(),
    },
  });
}

// ─── Admin API handlers ────────────────────────────────────────────────────────
// All admin endpoints share the same pattern:
//   1. Rate-limit check (brute-force lockout)
//   2. Password verification against env.ADMIN_PASSWORD (server-side secret)
//   3. Perform the privileged operation
// The ADMIN_PASSWORD secret is never transmitted to the client in any response.

async function handleAdminVerify(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.ADMIN_PASSWORD)       return jsonResponse({ error: 'Admin password not configured' }, 500);

  const ip = getClientIP(request);
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    const mins = Math.ceil(rl.retryAfter / 60);
    return jsonResponse(
      { error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  // Validate password type before comparison — reject non-strings to prevent
  // unexpected type-coercion equality bugs.
  if (typeof body.password !== 'string') return jsonResponse({ error: 'Bad request' }, 400);

  if (body.password === env.ADMIN_PASSWORD) {
    await clearRateLimit(env, ip);
    return jsonResponse({ success: true });
  }

  await recordFailedAttempt(env, ip);
  const remaining = ADMIN_RL_MAX - (rl.count ?? 0) - 1;
  const hint = remaining > 0
    ? ` (${remaining} attempt${remaining !== 1 ? 's' : ''} remaining)`
    : ' — you are now locked out for 15 minutes.';
  return jsonResponse({ error: `Invalid password${hint}` }, 401);
}

async function handleAdminOrders(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  const ip = getClientIP(request);
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many failed attempts. Try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // Clamp pagination parameters — never trust client-supplied values.
  const limit = Math.min(typeof body.limit === 'number' ? Math.max(1, body.limit) : 50, 100);
  const params = new URLSearchParams({ limit: String(limit) });

  // Validate the cursor before passing it to Stripe — must look like a Stripe object ID.
  if (body.starting_after) {
    if (typeof body.starting_after !== 'string' || body.starting_after.length > 200 ||
        !/^cs_[a-zA-Z0-9_]+$/.test(body.starting_after)) {
      return jsonResponse({ error: 'Invalid starting_after cursor' }, 400);
    }
    params.set('starting_after', body.starting_after);
  }

  const stripeResp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions?${params.toString()}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );

  let sessions;
  try { sessions = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe returned non-JSON (HTTP ${stripeResp.status})` }, 500); }

  if (!stripeResp.ok) {
    return jsonResponse({ error: sessions.error?.message || 'Stripe error' }, 500);
  }

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
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many failed attempts. Try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  // ── Validate session ID format before embedding in the Stripe URL path ──
  const idError = validateSessionId(body.sessionId);
  if (idError) return jsonResponse({ error: idError }, 400);

  // ── Validate status against a strict whitelist ──
  const VALID_STATUSES = new Set(['pending', 'printing', 'shipped', 'delivered']);
  if (!VALID_STATUSES.has(body.status)) {
    return jsonResponse({ error: 'status must be one of: pending, printing, shipped, delivered' }, 400);
  }

  const formBody = encodeStripeForm({
    metadata: { fulfillment_status: body.status },
  }).join('&');

  const stripeResp = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(body.sessionId)}`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    },
  );

  let result;
  try { result = await stripeResp.json(); }
  catch { return jsonResponse({ error: `Stripe returned non-JSON (HTTP ${stripeResp.status})` }, 500); }

  if (!stripeResp.ok) {
    return jsonResponse({ error: result.error?.message || 'Stripe error' }, 500);
  }

  return jsonResponse({ success: true, status: body.status });
}

async function handleGetSettings(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const ip = getClientIP(request);
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many failed attempts. Try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

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
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many failed attempts. Try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

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
  const rl  = await checkRateLimit(env, ip);
  if (rl.blocked) {
    return jsonResponse(
      { error: 'Too many failed attempts. Try again later.' },
      429,
      { 'Retry-After': String(rl.retryAfter) },
    );
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }
  if (typeof body.password !== 'string' || body.password !== env.ADMIN_PASSWORD) {
    await recordFailedAttempt(env, ip);
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const current = await getContent(env);
  const gallery  = Array.isArray(body.gallery)
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

// ─── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      // Public
      case '/api/create-checkout':       return handleCreateCheckout(request, env);
      case '/api/order-info':            return handleOrderInfo(request, env);
      case '/api/order-availability':    return handleOrderAvailability(request, env);
      case '/api/ms-buildings':          return handleMsBuildings(request, env);
      case '/api/content':               return handleGetContent(request, env);

      // Admin (all require ADMIN_PASSWORD in request body)
      case '/api/admin-verify':          return handleAdminVerify(request, env);
      case '/api/admin-orders':          return handleAdminOrders(request, env);
      case '/api/admin-update-order':    return handleAdminUpdateOrder(request, env);
      case '/api/admin-settings':        return handleGetSettings(request, env);
      case '/api/admin-update-settings': return handleUpdateSettings(request, env);
      case '/api/admin-update-content':  return handleUpdateContent(request, env);
    }

    // All other paths → static assets (HTML, JS, CSS, images)
    return env.ASSETS.fetch(request);
  },
};
