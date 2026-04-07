/**
 * Cloudflare Pages Function — creates a Stripe Checkout session.
 * Shipping rates are region-locked: customers only see rates for their region.
 *
 * Uses the Stripe REST API directly (fetch) instead of the Node SDK so it
 * runs on the Cloudflare Workers runtime without needing nodejs_compat.
 */

const US_COUNTRIES = ['US'];
const CA_COUNTRIES = ['CA'];
const INTL_COUNTRIES = ['GB', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK', 'FI', 'IE', 'NZ'];

const SHIPPING_RATES = {
  US: [
    {
      type: 'fixed_amount',
      fixed_amount: { amount: 800, currency: 'usd' },
      display_name: 'Standard Shipping (USPS)',
      delivery_estimate: { min_days: 5, max_days: 10 },
    },
    {
      type: 'fixed_amount',
      fixed_amount: { amount: 1500, currency: 'usd' },
      display_name: 'Express Shipping (USPS Priority)',
      delivery_estimate: { min_days: 2, max_days: 4 },
    },
  ],
  CA: [
    {
      type: 'fixed_amount',
      fixed_amount: { amount: 1800, currency: 'usd' },
      display_name: 'Standard Shipping to Canada',
      delivery_estimate: { min_days: 7, max_days: 14 },
    },
  ],
  INTL: [
    {
      type: 'fixed_amount',
      fixed_amount: { amount: 3000, currency: 'usd' },
      display_name: 'International Shipping',
      delivery_estimate: { min_days: 10, max_days: 21 },
    },
  ],
};

function getShippingForRegion(region) {
  if (region === 'CA') return { countries: CA_COUNTRIES, rates: SHIPPING_RATES.CA };
  if (region === 'INTL') return { countries: INTL_COUNTRIES, rates: SHIPPING_RATES.INTL };
  return { countries: US_COUNTRIES, rates: SHIPPING_RATES.US };
}

// Encode a JS object as application/x-www-form-urlencoded with Stripe's
// bracketed array/dict syntax (e.g. line_items[0][price_data][currency]=usd).
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

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { lat, lng, radius, verticalScale, elevation, invertColors, colorMode, region } = body;

    if (lat == null || lng == null || radius == null) {
      return new Response(JSON.stringify({ error: 'Missing location data' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const unitAmount = invertColors ? 4000 : 3500;
    const modelDesc = `3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x | ${invertColors ? 'Inverted' : 'Standard'} colors`;

    const shipping = getShippingForRegion(region || 'US');

    // Build shipping_options entries in Stripe's expected shape
    const shippingOptions = shipping.rates.map((r) => ({
      shipping_rate_data: {
        type: r.type,
        fixed_amount: r.fixed_amount,
        display_name: r.display_name,
        delivery_estimate: {
          minimum: { unit: 'business_day', value: r.delivery_estimate.min_days },
          maximum: { unit: 'business_day', value: r.delivery_estimate.max_days },
        },
      },
    }));

    const origin = request.headers.get('origin') || 'http://localhost:5173';

    const payload = {
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Cities3ds — Custom 3D Map',
              description: modelDesc,
              images: ['https://cities3ds.com/preview.png'],
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: { allowed_countries: shipping.countries },
      shipping_options: shippingOptions,
      metadata: {
        lat: String(lat),
        lng: String(lng),
        radius: String(radius),
        verticalScale: String(verticalScale),
        elevation: String(elevation),
        invertColors: String(invertColors),
        colorMode: colorMode || 'standard',
        region: region || 'US',
      },
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app.html`,
    };

    const formBody = encodeStripeForm(payload).join('&');

    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody,
    });

    const session = await stripeResp.json();

    if (!stripeResp.ok) {
      console.error('Stripe error:', session);
      return new Response(JSON.stringify({ error: session.error?.message || 'Stripe error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
