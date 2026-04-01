/**
 * Netlify serverless function — updates order fulfillment status in Stripe metadata.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { password, sessionId, status } = JSON.parse(event.body);

    if (password !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const validStatuses = ['pending', 'printing', 'shipped', 'delivered'];
    if (!validStatuses.includes(status)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid status' }) };
    }

    // Update the checkout session metadata
    await stripe.checkout.sessions.update(sessionId, {
      metadata: { fulfillment_status: status },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, status }),
    };
  } catch (err) {
    console.error('Update order error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
