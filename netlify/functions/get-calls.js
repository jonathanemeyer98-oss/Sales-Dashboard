/**
 * netlify/functions/get-calls.js
 *
 * Returns call data to the dashboard frontend.
 * Endpoint: GET /.netlify/functions/get-calls
 * Optional query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&missed=true
 */

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url    = new URL(req.url);
  const from   = url.searchParams.get('from');
  const to     = url.searchParams.get('to');
  const missed = url.searchParams.get('missed') === 'true';
  const id     = url.searchParams.get('id');

  const store = getStore('calls');

  // Single call detail
  if (id) {
    try {
      const call = await store.get(id, { type: 'json' });
      if (!call) return json({ error: 'Not found' }, 404);
      return json(call);
    } catch {
      return json({ error: 'Not found' }, 404);
    }
  }

  // Call list
  let index = [];
  try {
    index = await store.get('index', { type: 'json' }) || [];
  } catch { index = []; }

  // Filter by date
  if (from || to) {
    index = index.filter(c => {
      if (from && c.call_date < from) return false;
      if (to   && c.call_date > to)   return false;
      return true;
    });
  }

  // Filter missed opportunities only
  if (missed) {
    index = index.filter(c => c.is_missed_opportunity);
  }

  // Compute metrics
  const metrics = computeMetrics(index);

  return json({ calls: index, metrics });
};

export const config = { path: '/api/calls' };

function computeMetrics(calls) {
  const total      = calls.length;
  const closedWon  = calls.filter(c => c.outcome === 'closed_won').length;
  const noShows    = calls.filter(c => c.outcome === 'no_show').length;
  const cancelled  = calls.filter(c => c.outcome === 'cancelled').length;
  const closeRate  = total > 0 ? Math.round((closedWon / total) * 100) : 0;
  const avgScore   = total > 0 ? Math.round(calls.reduce((s, c) => s + (c.overall_score || 0), 0) / total) : 0;
  const missedOpps = calls.filter(c => c.is_missed_opportunity).length;

  return { total, closedWon, noShows, cancelled, closeRate, avgScore, missedOpps };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
