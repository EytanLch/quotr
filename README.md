# Quotr MVP — Proxy

A metered LLM quota exchange proxy. Buyers use this as a drop-in replacement
for the Anthropic API. You earn the spread between what Anthropic charges you
and what buyers pay.

## Architecture

```
Buyer → POST /v1/messages
         ↓
    [Auth] resolve API key → user_id
    [Rate limit] 60 req/min per user
    [Balance] check cents > 0
    [Forward] Anthropic master key
    [Stream] pipe response to buyer
    [Meter] deduct buyer_cost_cents async
         ↓
    Anthropic API
```

## Stack

| Component    | Technology         |
|--------------|--------------------|
| Runtime      | Bun                |
| HTTP server  | Hono               |
| Database     | Supabase (Postgres)|
| Cache        | Upstash Redis      |
| Payments     | Stripe             |
| Hosting      | Railway            |

## Local setup

```bash
# 1. Install Bun
curl -fsSL https://bun.sh/install | bash

# 2. Install dependencies
bun install

# 3. Copy env file and fill in values
cp .env.example .env

# 4. Run Supabase SQL migration
# Paste contents of supabase/schema.sql into your Supabase SQL editor

# 5. Add the credit_balance stored procedure in Supabase SQL editor:
# CREATE OR REPLACE FUNCTION credit_balance(p_user_id uuid, p_cents integer)
# RETURNS void AS $$
# BEGIN
#   INSERT INTO balances (user_id, cents)
#   VALUES (p_user_id, p_cents)
#   ON CONFLICT (user_id)
#   DO UPDATE SET cents = balances.cents + p_cents, updated_at = now();
# END;
# $$ LANGUAGE plpgsql;

# 6. Start the server
bun run dev
```

## First buyer — step by step

### 1. Onboard a buyer

```bash
curl -X POST http://localhost:3000/admin/users \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: your-admin-secret" \
  -d '{"email": "buyer@example.com"}'
```

Response:
```json
{
  "user_id": "uuid-here",
  "email": "buyer@example.com",
  "api_key": "qr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "note": "Store this key — it cannot be retrieved again."
}
```

Email the api_key to the buyer. They use it exactly like an Anthropic key.

### 2. Top up their balance (MVP: do this manually after Stripe payment)

Create a Stripe payment link. Set the metadata field:
```
quotr_user_id = <their user_id>
```

When they pay, Stripe fires the webhook → balance is auto-credited.

### 3. Buyer makes a request

```bash
curl -X POST https://your-railway-app.railway.app/v1/messages \
  -H "Authorization: Bearer qr_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Identical to the Anthropic API — buyers can swap the base URL and it just works.

### 4. Check platform stats

```bash
curl http://localhost:3000/admin/stats \
  -H "x-admin-secret: your-admin-secret"
```

## Pricing

Edit these values in `.env`:

```
ANTHROPIC_INPUT_PRICE_PER_M=3.00   # what Anthropic charges you
ANTHROPIC_OUTPUT_PRICE_PER_M=15.00
PLATFORM_MARKUP=1.20                # buyers pay 20% more than cost
PLATFORM_FEE=0.02                   # your cut (phase 2: when sellers exist)
```

## Deploy to Railway

```bash
# 1. Push to GitHub
git init && git add . && git commit -m "Quotr MVP"
gh repo create quotr-proxy --private --push

# 2. Create Railway project
# - Connect your GitHub repo
# - Add all env vars from .env.example
# - Railway auto-detects Bun via nixpacks

# 3. Set up Stripe webhook
# - Add endpoint: https://your-app.railway.app/webhooks/stripe
# - Events: checkout.session.completed, payment_intent.succeeded
# - Copy the webhook signing secret → STRIPE_WEBHOOK_SECRET env var
```

## Security checklist before going live

- [ ] `ADMIN_SECRET` is a strong random string (not "change-me-in-production")
- [ ] `/admin/*` routes are firewalled at Railway (only your IP)
- [ ] Anthropic spend cap is set in the Anthropic dashboard
- [ ] Supabase RLS policies are reviewed
- [ ] Upstash Redis has a max memory policy set (`allkeys-lru`)
- [ ] Railway has auto-sleep disabled (keep-alive on)

## File structure

```
src/
  index.ts      # app entry point, route definitions
  config.ts     # env vars, initialized clients
  proxy.ts      # core proxy logic (the heart of Quotr)
  balance.ts    # balance read/write (Redis + Postgres)
  keys.ts       # API key creation, hashing, resolution
  pricing.ts    # cost calculation in integer cents
  logger.ts     # usage persistence
  webhook.ts    # Stripe webhook handler
  admin.ts      # internal admin routes
supabase/
  schema.sql    # all table definitions
.env.example
railway.toml
```
 
