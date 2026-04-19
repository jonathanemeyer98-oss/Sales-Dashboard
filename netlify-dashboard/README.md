# Sales Dashboard — Netlify Setup

## What's in this folder

```
index.html                          ← your dashboard (already live on Netlify)
netlify.toml                        ← Netlify config
package.json                        ← dependencies
netlify/functions/
  fathom-webhook.js                 ← receives Fathom calls, scores with Claude AI
  get-calls.js                      ← serves call data to dashboard
  register-webhook.js               ← registers your URL with Fathom (run once)
```

## Setup steps

### 1. Upload these files to Netlify

Option A — Netlify Drop (easiest):
- Go to netlify.com/drop
- Drag this entire folder onto the page

Option B — GitHub (recommended for updates):
- Push this folder to a GitHub repo
- Connect the repo in Netlify → New site from Git

### 2. Add environment variables in Netlify

Go to: Site settings → Environment variables → Add variable

Add these three:
```
ANTHROPIC_API_KEY    =  sk-ant-...        (from console.anthropic.com)
FATHOM_API_KEY       =  fathom_...        (from Fathom → Settings → API Access)
FATHOM_WEBHOOK_SECRET=                    (leave blank for now — filled in step 4)
```

### 3. Redeploy

After adding env vars, go to Deploys → Trigger deploy → Deploy site

### 4. Register your webhook with Fathom

Once deployed, open your browser and visit:
```
https://YOUR-SITE.netlify.app/api/register-webhook
```
but send it as a POST request. Easiest way — paste this into your browser console:

```javascript
fetch('/api/register-webhook', { method: 'POST' })
  .then(r => r.json())
  .then(console.log)
```

Copy the `secret` value from the response.

### 5. Add the webhook secret

Go back to Netlify → Environment variables → Add:
```
FATHOM_WEBHOOK_SECRET = whsec_...
```

Redeploy once more.

### 6. Test it

Record a call in Fathom. Within a few minutes of the call ending,
it will automatically appear in your dashboard with AI scoring.

## How it works

```
You record a call in Fathom
        ↓
Fathom sends webhook to /api/fathom-webhook
        ↓
Claude AI scores all 9 framework stages
Claude AI checks for missed opportunity
        ↓
Results saved to Netlify Blobs (built-in storage)
        ↓
Dashboard reads /api/calls and displays real data
```

## Costs

- Netlify free tier: $0/month (plenty for this use case)
- Anthropic API: ~$0.01-0.03 per call scored (~$1-3/month)
- Fathom: your existing subscription
