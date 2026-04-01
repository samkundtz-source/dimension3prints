/**
 * Netlify serverless function — fetches orders from Stripe for admin dashboard.
 * Requires admin password verification.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { password, limit = 50, starting_after } = JSON.parse(event.body);

    // Verify admin password
    if (password !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    // Fetch checkout sessions from Stripe
    const params = {
      limit: Math.min(limit, 100),
    };
    if (starting_after) params.starting_after = starting_after;

    const sessions = await stripe.checkout.sessions.list(params);

    // Map to a clean order format
    const orders = sessions.data
      .filter(s => s.payment_status === 'paid')
      .map(s => ({
        id: s.id,
        paymentIntent: s.payment_intent,
        created: s.created,
        amount: s.amount_total,
        currency: s.currency,
        status: s.metadata?.fulfillment_status || 'pending',
        email: s.customer_details?.email || '',
        name: s.customer_details?.name || s.shipping_details?.name || '',
        shipping: s.shipping_details?.address ? {
          name: s.shipping_details.name,
          line1: s.shipping_details.address.line1,
          line2: s.shipping_details.address.line2,
          city: s.shipping_details.address.city,
          state: s.shipping_details.address.state,
          postal: s.shipping_details.address.postal_code,
          country: s.shipping_details.address.country,
        } : null,
        shippingRate: s.shipping_cost?.amount_total || 0,
        model: {
          lat: parseFloat(s.metadata?.lat) || 0,
          lng: parseFloat(s.metadata?.lng) || 0,
          radius: parseFloat(s.metadata?.radius) || 1,
          verticalScale: parseFloat(s.metadata?.verticalScale) || 3,
          elevation: s.metadata?.elevation === 'true',
          invertColors: s.metadata?.invertColors === 'true',
          colorMode: s.metadata?.colorMode || 'standard',
        },
      }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orders,
        hasMore: sessions.has_more,
        lastId: sessions.data.length > 0 ? sessions.data[sessions.data.length - 1].id : null,
      }),
    };
  } catch (err) {
    console.error('Admin orders error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
