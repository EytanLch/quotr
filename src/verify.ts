// src/verify.ts
// Verifies a seller's Anthropic API key and checks their credit balance.
// Called during seller onboarding and periodically to refresh balance data.

import { db } from './config.ts'
import { decryptKey } from './crypto.ts'

interface VerificationResult {
  valid:         boolean
  balanceCents:  number
  error?:        string
}

/**
 * Verify a raw Anthropic API key by making a minimal API call.
 * Uses the models list endpoint — cheap, fast, requires valid auth.
 * Returns the estimated credit balance from response headers.
 */
export async function verifyAnthropicKey(rawKey: string): Promise<VerificationResult> {
  try {
    // Hit the models endpoint — lightest possible authenticated request
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key':         rawKey,
        'anthropic-version': '2023-06-01',
      },
    })

    if (res.status === 401) {
      return { valid: false, balanceCents: 0, error: 'Invalid API key' }
    }

    if (res.status === 403) {
      return { valid: false, balanceCents: 0, error: 'Key does not have required permissions' }
    }

    if (!res.ok) {
      return { valid: false, balanceCents: 0, error: `Anthropic returned ${res.status}` }
    }

    // Key is valid. Now fetch their credit balance via the billing API.
    const balanceCents = await fetchCreditBalance(rawKey)

    return { valid: true, balanceCents }

  } catch (err) {
    return { valid: false, balanceCents: 0, error: String(err) }
  }
}

/**
 * Fetch credit balance from Anthropic's usage API.
 * Anthropic exposes this at /v1/organizations/me/usage — returns remaining credits.
 * If unavailable, we fall back to 0 and ask seller to self-report.
 */
async function fetchCreditBalance(rawKey: string): Promise<number> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/organizations/me', {
      headers: {
        'x-api-key':         rawKey,
        'anthropic-version': '2023-06-01',
      },
    })

    if (!res.ok) return 0

    const data = await res.json() as { billing?: { available_credits_usd?: number } }
    const usd  = data?.billing?.available_credits_usd ?? 0
    return Math.floor(usd * 100)  // convert to cents

  } catch {
    // Balance API unavailable — return 0, seller self-reports
    return 0
  }
}

/**
 * Re-verify a seller's stored encrypted key and update their balance.
 * Called on a schedule and before activating a listing.
 */
export async function reverifyseller(sellerId: string): Promise<VerificationResult> {
  const { data: seller, error } = await db
    .from('sellers')
    .select('encrypted_key')
    .eq('id', sellerId)
    .single()

  if (error || !seller) {
    return { valid: false, balanceCents: 0, error: 'Seller not found' }
  }

  const rawKey = await decryptKey(seller.encrypted_key)
  const result = await verifyAnthropicKey(rawKey)

  // Log the verification attempt
  await db.from('verification_log').insert({
    seller_id:      sellerId,
    success:        result.valid,
    verified_cents: result.balanceCents,
    error:          result.error ?? null,
  })

  if (result.valid) {
    await db.from('sellers').update({
      verified_cents: result.balanceCents,
      verified_at:    new Date().toISOString(),
      status:         'active',
    }).eq('id', sellerId)
  }

  return result
}

/**
 * Quick key format check before making a network call.
 * Anthropic keys start with 'sk-ant-'.
 */
export function isValidKeyFormat(key: string): boolean {
  return key.startsWith('sk-ant-') && key.length > 20
}
