// src/seller.ts
// Seller-facing API routes.
// Sellers submit their Anthropic key, we verify it, they create listings.

import type { Context } from 'hono'
import { z } from 'zod'
import { db } from './config.ts'
import { encryptKey, keyHint } from './crypto.ts'
import { verifyAnthropicKey, reverifyseller, isValidKeyFormat } from './verify.ts'
import { createApiKey } from './keys.ts'

// ─── POST /sellers/register ───────────────────────────────────
// Step 1: seller creates an account and submits their Anthropic key.
// We verify it immediately — if invalid, we reject without storing.

const RegisterSchema = z.object({
  email:        z.string().email(),
  anthropic_key: z.string().min(20),
  // Self-reported credit balance in USD (we verify this independently)
  reported_balance_usd: z.number().positive(),
})

export async function sellerRegister(c: Context): Promise<Response> {
  const body   = await c.req.json().catch(() => null)
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) return err(400, parsed.error.flatten())

  const { email, anthropic_key, reported_balance_usd } = parsed.data

  // ── 1. Basic format check ─────────────────────────────────
  if (!isValidKeyFormat(anthropic_key)) {
    return err(400, 'Invalid Anthropic key format. Keys start with sk-ant-')
  }

  // ── 2. Verify key with Anthropic ──────────────────────────
  const verification = await verifyAnthropicKey(anthropic_key)
  if (!verification.valid) {
    return err(400, `Key verification failed: ${verification.error}`)
  }

  // ── 3. Create user if doesn't exist ───────────────────────
  let userId: string
  const { data: existing } = await db
    .from('users').select('id').eq('email', email).single()

  if (existing) {
    userId = existing.id
  } else {
    const { data: newUser, error: userErr } = await db
      .from('users').insert({ email }).select().single()
    if (userErr) return err(500, userErr.message)
    userId = newUser.id
    await db.from('balances').insert({ user_id: userId, cents: 0 })
  }

  // ── 4. Encrypt and store the key ──────────────────────────
  const encryptedKey = await encryptKey(anthropic_key)
  const hint         = keyHint(anthropic_key)

  const { data: seller, error: sellerErr } = await db
    .from('sellers').insert({
      user_id:        userId,
      encrypted_key:  encryptedKey,
      key_hint:       hint,
      verified_cents: verification.balanceCents ||
                      Math.floor(reported_balance_usd * 100),
      verified_at:    new Date().toISOString(),
      status:         'active',
    }).select().single()

  if (sellerErr) return err(500, sellerErr.message)

  // ── 5. Issue seller an API key (for dashboard access) ─────
  const sellerApiKey = await createApiKey(userId)

  return json(201, {
    seller_id:        seller.id,
    key_hint:         hint,
    verified_balance: `$${(verification.balanceCents / 100).toFixed(2)}`,
    api_key:          sellerApiKey,
    next:             'Create a listing at POST /sellers/listings',
  })
}

// ─── POST /sellers/listings ───────────────────────────────────
// Step 2: seller creates a listing — sets model, price, token amount, expiry.

const ListingSchema = z.object({
  seller_id:     z.string().uuid(),
  model:         z.enum([
    'claude-haiku-4-5',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
  ]),
  // Price in USD cents per 1M input tokens
  // Must be below Anthropic's retail price to be competitive:
  // Haiku: <300 cents/M, Sonnet: <300 cents/M, Opus: <1500 cents/M
  ask_cents_per_m: z.number().int().min(1).max(5000),
  // How many million tokens they're listing
  tokens_m:        z.number().positive().max(100),
  // When their Anthropic credits expire (ISO date string)
  expires_at:      z.string().datetime(),
  auto_discount:   z.boolean().default(true),
})

export async function sellerCreateListing(c: Context): Promise<Response> {
  const body   = await c.req.json().catch(() => null)
  const parsed = ListingSchema.safeParse(body)
  if (!parsed.success) return err(400, parsed.error.flatten())

  const { seller_id, model, ask_cents_per_m, tokens_m, expires_at, auto_discount } = parsed.data

  // ── Verify seller exists and is active ────────────────────
  const { data: seller, error: sellerErr } = await db
    .from('sellers').select('id, status, verified_cents')
    .eq('id', seller_id).single()

  if (sellerErr || !seller) return err(404, 'Seller not found')
  if (seller.status !== 'active') return err(400, `Seller status is ${seller.status} — cannot create listing`)

  // ── Sanity check expiry ───────────────────────────────────
  if (new Date(expires_at) <= new Date()) {
    return err(400, 'expires_at must be in the future')
  }

  // ── Create listing ────────────────────────────────────────
  const totalTokens = Math.floor(tokens_m * 1_000_000)

  const { data: listing, error: listErr } = await db
    .from('listings').insert({
      seller_id,
      model,
      ask_cents_per_m,
      total_tokens:  totalTokens,
      used_tokens:   0,
      expires_at,
      auto_discount,
      status:        'active',
    }).select().single()

  if (listErr) return err(500, listErr.message)

  // Anthropic retail price per model for reference
  const retailPrice: Record<string, number> = {
    'claude-haiku-4-5':            300,
    'claude-sonnet-4-5':           300,
    'claude-opus-4-5':             1500,
    'claude-3-5-sonnet-20241022':  300,
    'claude-3-5-haiku-20241022':   80,
  }

  const retail   = retailPrice[model] ?? 300
  const discount = Math.round((1 - ask_cents_per_m / retail) * 100)

  return json(201, {
    listing_id:      listing.id,
    model,
    ask_cents_per_m,
    discount_vs_anthropic: discount > 0 ? `${discount}% below retail` : 'at or above retail',
    total_tokens:    totalTokens.toLocaleString(),
    expires_at,
    auto_discount,
    status:          'active',
  })
}

// ─── GET /sellers/:id/listings ────────────────────────────────
// Seller dashboard — see their active listings and earnings.

export async function sellerGetListings(c: Context): Promise<Response> {
  const sellerId = c.req.param('id')

  const { data: listings } = await db
    .from('listings')
    .select('*')
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })

  const { data: earnings } = await db
    .from('seller_earnings')
    .select('earned_cents')
    .eq('seller_id', sellerId)

  const totalEarned = earnings?.reduce((s, e) => s + e.earned_cents, 0) ?? 0

  return json(200, {
    listings:      listings ?? [],
    total_earned:  `$${(totalEarned / 100).toFixed(2)}`,
  })
}

// ─── GET /market ──────────────────────────────────────────────
// Public order book — shows all active listings sorted by price.
// This is what buyers see when browsing the marketplace.

export async function getMarket(c: Context): Promise<Response> {
  const model = c.req.query('model') ?? 'claude-haiku-4-5'

  const { data: listings } = await db
    .from('listings')
    .select(`
      id,
      model,
      ask_cents_per_m,
      total_tokens,
      used_tokens,
      expires_at,
      auto_discount,
      sellers(key_hint)
    `)
    .eq('model', model)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .order('ask_cents_per_m', { ascending: true })

  // Anthropic retail for comparison
  const retail: Record<string, number> = {
    'claude-haiku-4-5': 300,
    'claude-sonnet-4-5': 300,
    'claude-opus-4-5': 1500,
  }

  const enriched = (listings ?? []).map(l => ({
    ...l,
    available_tokens: l.total_tokens - l.used_tokens,
    discount_pct:     Math.round((1 - l.ask_cents_per_m / (retail[l.model] ?? 300)) * 100),
    price_per_m_usd:  `$${(l.ask_cents_per_m / 100).toFixed(3)}`,
  }))

  return json(200, {
    model,
    anthropic_retail_cents_per_m: retail[model] ?? 300,
    listings: enriched,
  })
}

// ─── POST /sellers/:id/reverify ───────────────────────────────
// Re-verify a seller's key and refresh their balance.

export async function sellerReverify(c: Context): Promise<Response> {
  const sellerId = c.req.param('id')
  const result   = await reverifyseller(sellerId)

  return json(result.valid ? 200 : 400, result)
}

// ─── Helpers ──────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function err(status: number, message: unknown): Response {
  return json(status, { error: message })
}
