/**
 * Netlify serverless function — verifies admin password.
 * The admin password lives in Netlify environment variables.
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { password } = JSON.parse(event.body);
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Admin password not configured' }) };
    }

    if (password === adminPassword) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    } else {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid password' }),
      };
    }
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bad request' }) };
  }
};
