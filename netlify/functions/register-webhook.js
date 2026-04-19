/**
 * netlify/functions/register-webhook.js
 *
 * Call this once to register your Netlify URL with Fathom.
 * Endpoint: POST /.netlify/functions/register-webhook
 *
 * Fathom will then automatically POST to /api/fathom-webhook
 * after every recorded call.
 */

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const FATHOM_API_KEY = process.env.FATHOM_API_KEY;
  const SITE_URL       = process.env.URL; // Netlify sets this automatically

  if (!FATHOM_API_KEY) {
    return json({ error: 'FATHOM_API_KEY not set in environment variables' }, 400);
  }

  const destinationUrl = `${SITE_URL}/api/fathom-webhook`;

  const res = await fetch('https://api.fathom.ai/external/v1/webhooks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': FATHOM_API_KEY,
    },
    body: JSON.stringify({
      destination_url: destinationUrl,
      triggered_for: [
        'my_recordings',
        'my_shared_with_team_recordings',
        'shared_team_recordings',
      ],
      include_summary:      true,
      include_transcript:   true,
      include_action_items: true,
      include_crm_matches:  true,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    return json({ error: 'Fathom API error', details: data }, 500);
  }

  return json({
    success: true,
    webhook_id: data.id,
    destination: data.url,
    secret: data.secret,
    message: 'Copy the secret above and add it to Netlify as FATHOM_WEBHOOK_SECRET',
  });
};

export const config = { path: '/api/register-webhook' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
