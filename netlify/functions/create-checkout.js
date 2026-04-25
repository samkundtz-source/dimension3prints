/**
 * Netlify serverless function — creates a Stripe Checkout session.
 * Shipping rates are region-locked: customers only see rates for their region.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Region definitions
const US_COUNTRIES = ['US'];
const CA_COUNTRIES = ['CA'];
const INTL_COUNTRIES = ['GB', 'AU', 'DE', 'FR', 'NL', 'SE', 'NO', 'DK', 'FI', 'IE', 'NZ'];
const ALL_COUNTRIES = [...US_COUNTRIES, ...CA_COUNTRIES, ...INTL_COUNTRIES];

// Shipping rates per region
const SHIPPING_RATES = {
  US: [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 800, currency: 'usd' },
        display_name: 'Standard Shipping (USPS)',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 5 },
          maximum: { unit: 'business_day', value: 10 },
        },
      },
    },
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 1500, currency: 'usd' },
        display_name: 'Express Shipping (USPS Priority)',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 2 },
          maximum: { unit: 'business_day', value: 4 },
        },
      },
    },
  ],
  CA: [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 1800, currency: 'usd' },
        display_name: 'Standard Shipping to Canada',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 7 },
          maximum: { unit: 'business_day', value: 14 },
        },
      },
    },
  ],
  INTL: [
    {
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 3000, currency: 'usd' },
        display_name: 'International Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 10 },
          maximum: { unit: 'business_day', value: 21 },
        },
      },
    },
  ],
};

function getShippingForRegion(region) {
  if (region === 'CA') return { countries: CA_COUNTRIES, rates: SHIPPING_RATES.CA };
  if (region === 'INTL') return { countries: INTL_COUNTRIES, rates: SHIPPING_RATES.INTL };
  return { countries: US_COUNTRIES, rates: SHIPPING_RATES.US };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { lat, lng, radius, verticalScale, elevation, invertColors, colorMode, region } = body;

    if (lat == null || lng == null || radius == null) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing location data' }) };
    }

    // Pricing: standard $29.99, inverted (black buildings / white roads) $34.99
    const unitAmount = invertColors ? 3499 : 2999;

    const modelDesc = `3D Map Print — ${lat.toFixed(4)}, ${lng.toFixed(4)} | Radius: ${radius}km | Scale: ${verticalScale}x | ${invertColors ? 'Inverted' : 'Standard'} colors`;

    // Get region-specific shipping (defaults to US if not specified)
    const shipping = getShippingForRegion(region || 'US');

    const session = await stripe.checkout.sessions.create({
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
      // Only allow countries from their selected region
      shipping_address_collection: {
        allowed_countries: shipping.countries,
      },
      // Only show shipping rates for their region
      shipping_options: shipping.rates,
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
      success_url: `${event.headers.origin || 'http://localhost:5173'}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${event.headers.origin || 'http://localhost:5173'}/app.html`,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
