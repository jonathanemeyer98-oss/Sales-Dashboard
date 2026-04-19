/**
 * netlify/functions/fathom-webhook.js
 *
 * Receives Fathom webhook after every recorded call.
 * Scores the call across 9 sales framework stages using Claude AI.
 * Stores results in Netlify Blobs (built-in key-value storage).
 *
 * Endpoint: POST /.netlify/functions/fathom-webhook
 */

import crypto from 'crypto';
import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const FATHOM_WEBHOOK_SECRET = process.env.FATHOM_WEBHOOK_SECRET;

const FRAMEWORK_STAGES = [
  { key: 'intro_rapport',      label: 'Intro & Rapport' },
  { key: 'problem_awareness',  label: 'Problem Awareness' },
  { key: 'situation_pain',     label: 'Situation / Pain' },
  { key: 'ownership_coi',      label: 'Ownership & Cost of Inaction' },
  { key: 'goal_state',         label: 'Goal State' },
  { key: 'pitch',              label: 'Pitch' },
  { key: 'price_drop',         label: 'Price Drop' },
  { key: 'objection_handling', label: 'Objection Handling' },
  { key: 'call_time',          label: 'Call Time' },
];

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await req.text();

  // Verify Fathom signature
  if (FATHOM_WEBHOOK_SECRET) {
    const sig = req.headers.get('fathom-signature') || '';
    if (!verifySignature(rawBody, sig, FATHOM_WEBHOOK_SECRET)) {
      console.warn('[fathom] Invalid signature');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  // Ack immediately
  const payload = JSON.parse(rawBody);

  // Process async (Netlify background function would be ideal but this works for most calls)
  try {
    await processCall(payload);
  } catch (err) {
    console.error('[fathom] Processing error:', err.message);
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = { path: '/api/fathom-webhook' };

// ── Core processing ───────────────────────────────────────────────
async function processCall(payload) {
  const meeting     = payload.meeting      || {};
  const summary     = payload.summary      || '';
  const transcript  = payload.transcript   || '';
  const actionItems = payload.action_items || [];
  const crmMatches  = payload.crm_matches  || [];

  if (!transcript && !summary) {
    console.warn('[fathom] No content to score');
    return;
  }

  const scoring       = await scoreCall({ summary, transcript, actionItems, meeting });
  const prospectName  = extractProspectName(crmMatches, meeting);
  const outcome       = detectOutcome(crmMatches, summary);
  const missedOpp     = await detectMissedOpportunity({ summary, transcript, outcome, scoring });

  const callRecord = {
    id:               generateId(),
    prospect_name:    prospectName,
    call_date:        meeting.started_at ? meeting.started_at.split('T')[0] : today(),
    duration_minutes: meeting.duration_minutes || 0,
    outcome,
    overall_score:    scoring.overall,
    summary,
    fathom_url:       meeting.url || '',
    coaching_tags:    scoring.tags,
    biggest_issue:    scoring.biggestIssue,
    scores:           scoring.stages,
    objections:       scoring.objections || [],
    missed_opportunity: missedOpp,
    created_at:       new Date().toISOString(),
  };

  await saveCall(callRecord);
  console.log(`[fathom] Saved call for ${prospectName} — score ${scoring.overall}/100`);
}

// ── Claude AI scoring ─────────────────────────────────────────────
async function scoreCall({ summary, transcript, actionItems, meeting }) {
  const content = [
    summary     && `CALL SUMMARY:\n${summary}`,
    transcript  && `TRANSCRIPT:\n${transcript.slice(0, 4000)}`,
    actionItems.length && `ACTION ITEMS:\n${actionItems.map(a => `- ${a.text}`).join('\n')}`,
  ].filter(Boolean).join('\n\n---\n\n');

  const prompt = `You are an expert sales coach. Analyse this sales call and return a JSON object only — no markdown, no commentary.

Score each framework stage 0-100:
- 85-100: Excellent
- 70-84: Good
- 55-69: Average
- 40-54: Below average
- 0-39: Poor / missed

Also identify specific objections raised and whether they were handled.

CALL CONTENT:
${content}

Return ONLY this JSON:
{
  "stages": {
    "intro_rapport": <0-100>,
    "problem_awareness": <0-100>,
    "situation_pain": <0-100>,
    "ownership_coi": <0-100>,
    "goal_state": <0-100>,
    "pitch": <0-100>,
    "price_drop": <0-100>,
    "objection_handling": <0-100>,
    "call_time": <0-100>
  },
  "overall": <0-100>,
  "tags": ["<coaching tag>"],
  "biggestIssue": "<one sentence>",
  "objections": [
    { "text": "<objection raised>", "handled": "yes" | "no" }
  ]
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';

  try {
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    return {
      overall:   result.overall   || 0,
      stages:    result.stages    || {},
      tags:      result.tags      || [],
      biggestIssue: result.biggestIssue || '',
      objections: result.objections || [],
    };
  } catch {
    return { overall: 0, stages: {}, tags: [], biggestIssue: '', objections: [] };
  }
}

// ── Missed opportunity detection ──────────────────────────────────
async function detectMissedOpportunity({ summary, transcript, outcome, scoring }) {
  if (outcome === 'closed_won') return null;

  const content = [summary, transcript.slice(0, 2000)].filter(Boolean).join('\n\n');

  const prompt = `You are an expert sales coach. Analyse this sales call and determine if it was a genuine missed opportunity — meaning the prospect showed real buying signals but the deal was not closed due to a rep error.

Do NOT flag tyre kickers who were never going to buy.

CALL CONTENT:
${content}

OUTCOME: ${outcome}
OVERALL SCORE: ${scoring.overall}/100

Return ONLY this JSON (no markdown):
{
  "is_missed_opportunity": true | false,
  "buying_signal_score": <0-100>,
  "buying_signals": ["<specific signal from the call>"],
  "breakdown_stage": "<which framework stage failed>",
  "diagnosis": "<2-3 sentences on what went wrong>",
  "should_have": "<one sentence on what should have happened instead>"
}

Only return is_missed_opportunity: true if buying_signal_score is 70 or above AND you can identify a clear rep error.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json();
  const text = data.content?.find(b => b.type === 'text')?.text || '{}';

  try {
    const result = JSON.parse(text.replace(/```json|```/g, '').trim());
    return result.is_missed_opportunity ? result : null;
  } catch {
    return null;
  }
}

// ── Storage (Netlify Blobs) ───────────────────────────────────────
async function saveCall(callRecord) {
  const store = getStore('calls');

  // Save individual call
  await store.setJSON(callRecord.id, callRecord);

  // Update the index (list of all call IDs + summary)
  let index = [];
  try {
    index = await store.get('index', { type: 'json' }) || [];
  } catch { index = []; }

  index.unshift({
    id:            callRecord.id,
    prospect_name: callRecord.prospect_name,
    call_date:     callRecord.call_date,
    duration_minutes: callRecord.duration_minutes,
    outcome:       callRecord.outcome,
    overall_score: callRecord.overall_score,
    fathom_url:    callRecord.fathom_url,
    is_missed_opportunity: !!callRecord.missed_opportunity,
  });

  // Keep last 200 calls in index
  if (index.length > 200) index = index.slice(0, 200);
  await store.setJSON('index', index);
}

// ── Helpers ───────────────────────────────────────────────────────
function verifySignature(body, signature, secret) {
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}

function extractProspectName(crmMatches, meeting) {
  if (crmMatches?.length > 0) return crmMatches[0].contact_name || crmMatches[0].lead_name || 'Unknown';
  const title = meeting.title || '';
  const match = title.match(/(?:call|meeting|with)\s+(.+)/i);
  return match ? match[1].trim() : title || 'Unknown';
}

function detectOutcome(crmMatches, summary) {
  const text = (summary + ' ' + JSON.stringify(crmMatches)).toLowerCase();
  if (text.includes('closed won')  || text.includes('deal closed'))  return 'closed_won';
  if (text.includes('closed lost'))                                   return 'closed_lost';
  if (text.includes('no show')     || text.includes('no-show'))       return 'no_show';
  if (text.includes('cancel'))                                        return 'cancelled';
  if (text.includes('proposal')    || text.includes('follow up'))     return 'proposal_sent';
  return 'discovery';
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function today() {
  return new Date().toISOString().split('T')[0];
}
