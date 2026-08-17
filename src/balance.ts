import { redis, db } from './config.ts'
import { MIN_BALANCE_CENTS } from './pricing.ts'

const balanceKey = (userId: string) => `quotr:balance:${userId}`

/**
 * Get a user's balance in cents.
 * Redis is the hot read path; Postgres is authoritative.
 */
export async function getBalance(userId: string): Promise<number> {
  const cached = await redis.get<number>(balanceKey(userId))
  if (cached !== null) return cached

  const { data } = await db
    .from('balances')
    .select('cents')
    .eq('user_id', userId)
    .single()

  const cents = data?.cents ?? 0
  await redis.set(balanceKey(userId), cents, { ex: 3600 })
  return cents
}

/**
 * Check if a user has enough balance to make a request.
 */
export async function hasSufficientBalance(userId: string): Promise<boolean> {
  const balance = await getBalance(userId)
  return balance >= MIN_BALANCE_CENTS
}

/**
 * Deduct cents from a user's balance atomically.
 * Redis is decremented first (fast path); Postgres is updated async.
 * If Redis goes negative, we cap at 0 and log the discrepancy.
 */
export async function deductBalance(userId: string, cents: number): Promise<void> {
  // Atomic Redis decrement
  const newBalance = await redis.decrby(balanceKey(userId), cents)

  // If we went negative (race condition), clamp to 0
  if (newBalance < 0) {
    await redis.set(balanceKey(userId), 0)
  }

  // Persist to Postgres (fire and forget — reconciled by cron if needed)
  db.from('balances')
    .upsert({ user_id: userId, cents: Math.max(0, newBalance), updated_at: new Date().toISOString() })
    .then(({ error }) => {
      if (error) console.error(`[balance] Postgres sync failed for ${userId}:`, error.message)
    })
}

/**
 * Credit a user's balance (called by Stripe webhook on successful payment).
 * Postgres is written first; Redis is then synced.
 */
export async function creditBalance(userId: string, cents: number, stripeId: string): Promise<void> {
  // Upsert in Postgres atomically
  const { error } = await db.rpc('credit_balance', { p_user_id: userId, p_cents: cents })
  if (error) throw new Error(`Failed to credit balance: ${error.message}`)

  // Increment Redis cache
  await redis.incrby(balanceKey(userId), cents)

  // Record transaction
  await db.from('transactions').insert({
    user_id:   userId,
    type:      'topup',
    cents:     cents,
    stripe_id: stripeId,
  })
}

/**
 * Invalidate Redis cache for a user (call after manual balance adjustments).
 */
export async function invalidateBalanceCache(userId: string): Promise<void> {
  await redis.del(balanceKey(userId))
}
