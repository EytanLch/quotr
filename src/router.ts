// src/router.ts
// The marketplace routing layer.
// Instead of one master key, we route each request through
// the cheapest available seller's key for that model.

import { db, redis } from './config.ts'
import { decryptKey } from './crypto.ts'

const ROUTE_CACHE_TTL = 30  // seconds — how long we cache the best listing

interface Route {
  listingId:  string
  sellerId:   string
  apiKey:     string   // decrypted Anthropic key — held in memory only
  pricePerM:  number   // cents per 1M tokens
}

/**
 * Get the best route for a given model.
 * Returns the cheapest active listing's decrypted API key.
 *
 * Fast path: Redis cache (30s TTL to avoid DB query per request)
 * Slow path: Postgres get_best_listing() → decrypt key → cache
 */
export async function getBestRoute(model: string): Promise<Route | null> {
  // ── Fast path: check Redis cache ──────────────────────────
  const cacheKey   = `quotr:route:${model}`
  const cached     = await redis.get<{ listingId: string; sellerId: string; pricePerM: number }>(cacheKey)

  if (cached) {
    // Key is NOT cached in Redis — decrypt fresh each time for security
    const apiKey = await getDecryptedKey(cached.sellerId)
    if (!apiKey) {
      await redis.del(cacheKey)  // stale cache — clear it
      return null
    }
    return { ...cached, apiKey }
  }

  // ── Slow path: query Postgres ──────────────────────────────
  const { data, error } = await db.rpc('get_best_listing', { p_model: model })

  if (error || !data || data.length === 0) return null

  const best = data[0] as { listing_id: string; seller_id: string; effective_price: number }

  // Cache listing metadata (NOT the key) in Redis
  await redis.set(cacheKey, {
    listingId: best.listing_id,
    sellerId:  best.seller_id,
    pricePerM: best.effective_price,
  }, { ex: ROUTE_CACHE_TTL })

  // Decrypt key fresh (never cached in Redis)
  const apiKey = await getDecryptedKey(best.seller_id)
  if (!apiKey) return null

  return {
    listingId: best.listing_id,
    sellerId:  best.seller_id,
    apiKey,
    pricePerM: best.effective_price,
  }
}

/**
 * Fetch and decrypt a seller's Anthropic API key.
 * The encrypted key is fetched from Postgres.
 * The plaintext key is NEVER stored anywhere — only held in memory for the request.
 */
async function getDecryptedKey(sellerId: string): Promise<string | null> {
  const { data, error } = await db
    .from('sellers')
    .select('encrypted_key, status')
    .eq('id', sellerId)
    .single()

  if (error || !data || data.status !== 'active') return null

  try {
    return await decryptKey(data.encrypted_key)
  } catch (err) {
    console.error(`[router] Failed to decrypt key for seller ${sellerId}:`, err)
    return null
  }
}

/**
 * Record token usage against a listing after a request completes.
 * Updates listing's used_tokens and records seller earnings.
 * Fire-and-forget — doesn't block the response.
 */
export async function recordRouteUsage(
  route:        Route,
  inputTokens:  number,
  outputTokens: number,
  usageLogId:   string,
): Promise<void> {
  // Cost at Anthropic's actual price (what we pay)
  const anthropicCents = Math.ceil(
    (inputTokens / 1_000_000) * 3 +  // $3/M input
    (outputTokens / 1_000_000) * 15  // $15/M output
  )

  // What buyer paid (seller's price × markup — handled in proxy)
  const buyerCents = Math.ceil(
    (inputTokens / 1_000_000) * route.pricePerM * 1.02  // seller price + 2% platform fee
  )

  // Seller earns their ask price, minus platform 2% fee
  const platformCents = Math.ceil(buyerCents * 0.02)
  const sellerEarns   = buyerCents - platformCents

  // Deduct tokens from listing
  await db.rpc('deduct_listing_tokens', {
    p_listing_id: route.listingId,
    p_tokens:     inputTokens,
  })

  // Record seller earnings
  await db.from('seller_earnings').insert({
    seller_id:      route.sellerId,
    listing_id:     route.listingId,
    usage_log_id:   usageLogId,
    earned_cents:   sellerEarns,
    platform_cents: platformCents,
  })

  // Invalidate route cache if listing is near exhaustion
  const { data: listing } = await db
    .from('listings')
    .select('status, used_tokens, total_tokens')
    .eq('id', route.listingId)
    .single()

  if (listing && (listing.status === 'exhausted' || listing.used_tokens / listing.total_tokens > 0.95)) {
    await redis.del(`quotr:route:${listing}`)
  }
}

/**
 * Invalidate the route cache for a model.
 * Call this when a new listing is created or a listing changes status.
 */
export async function invalidateRouteCache(model: string): Promise<void> {
  await redis.del(`quotr:route:${model}`)
}
