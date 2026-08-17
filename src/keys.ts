import { nanoid } from 'nanoid'
import { redis, db } from './config.ts'

const KEY_PREFIX  = 'qr_live_'
const REDIS_TTL   = 60 * 60 * 24  // 24h cache; refreshed on use

export interface KeyRecord {
  userId:    string
  keyPrefix: string
}

/**
 * Hash an API key using the Web Crypto API (available in Bun).
 * We store only the hash in Postgres; plaintext is shown once at creation.
 */
export async function hashKey(key: string): Promise<string> {
  const buf    = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Create a new API key for a user.
 * Returns the plaintext key — store it, it won't be retrievable again.
 */
export async function createApiKey(userId: string): Promise<string> {
  const raw    = KEY_PREFIX + nanoid(32)
  const hash   = await hashKey(raw)
  const prefix = raw.slice(0, 12)

  const { error } = await db.from('api_keys').insert({
    user_id:    userId,
    key_hash:   hash,
    key_prefix: prefix,
  })

  if (error) throw new Error(`Failed to create API key: ${error.message}`)

  // Warm the Redis cache immediately
  await cacheKey(hash, { userId, keyPrefix: prefix })

  return raw
}

/**
 * Resolve a raw API key to its owner.
 * Fast path: Redis cache. Slow path: Postgres (then re-caches).
 * Returns null if the key is invalid or revoked.
 */
export async function resolveKey(raw: string): Promise<KeyRecord | null> {
  const hash = await hashKey(raw)

  // ── Fast path ─────────────────────────────────────────────
  const cached = await redis.get<KeyRecord>(`quotr:key:${hash}`)
  if (cached) return cached

  // ── Slow path ─────────────────────────────────────────────
  const { data, error } = await db
    .from('api_keys')
    .select('user_id, key_prefix, revoked_at')
    .eq('key_hash', hash)
    .single()

  if (error || !data || data.revoked_at) return null

  const record: KeyRecord = { userId: data.user_id, keyPrefix: data.key_prefix }
  await cacheKey(hash, record)
  return record
}

async function cacheKey(hash: string, record: KeyRecord): Promise<void> {
  await redis.set(`quotr:key:${hash}`, record, { ex: REDIS_TTL })
}

/**
 * Revoke a key: remove from Redis cache and mark in Postgres.
 */
export async function revokeKey(raw: string): Promise<void> {
  const hash = await hashKey(raw)
  await redis.del(`quotr:key:${hash}`)
  await db
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('key_hash', hash)
}
