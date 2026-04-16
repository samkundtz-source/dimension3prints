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

  const { lat, lng, radius, verticalScale, elevation, terrainRelief, region } = body;
  if (lat == null || lng == null || radius == null) {
    return jsonResponse({ error: 'Missing location data' }, 400);
  }

  const unitAmount = 3500; // flat $35
  const modelDesc  = `3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x${terrainRelief ? ' | Terrain relief' : ''}`;
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
      lat:           String(lat),
      lng:           String(lng),
      radius:        String(radius),
      verticalScale: String(verticalScale),
      elevation:     String(elevation),
      terrainRelief: String(terrainRelief || false),
      region:        region || 'US',
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

// ─── Admin endpoints ────────────────────────────────────────────────────────

async function handleAdminVerify(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.ADMIN_PASSWORD)       return jsonResponse({ error: 'Admin password not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password === env.ADMIN_PASSWORD) {
    return jsonResponse({ success: true });
  }
  return jsonResponse({ error: 'Invalid password' }, 401);
}

async function handleAdminOrders(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  if (!env.STRIPE_SECRET_KEY)    return jsonResponse({ error: 'Server is missing STRIPE_SECRET_KEY' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password !== env.ADMIN_PASSWORD) {
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
      model: {
        lat:           parseFloat(s.metadata?.lat) || 0,
        lng:           parseFloat(s.metadata?.lng) || 0,
        radius:        parseFloat(s.metadata?.radius) || 1,
        verticalScale: parseFloat(s.metadata?.verticalScale) || 3,
        elevation:     s.metadata?.elevation === 'true',
        terrainRelief: s.metadata?.terrainRelief === 'true',
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

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad request' }, 400); }

  if (body.password !== env.ADMIN_PASSWORD) {
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/api/create-checkout':    return handleCreateCheckout(request, env);
      case '/api/admin-verify':       return handleAdminVerify(request, env);
      case '/api/admin-orders':       return handleAdminOrders(request, env);
      case '/api/admin-update-order': return handleAdminUpdateOrder(request, env);
    }

    // Everything else → static assets
    return env.ASSETS.fetch(request);
  },
};
