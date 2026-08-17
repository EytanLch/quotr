import type { Context } from 'hono'
import { z } from 'zod'
import { db } from './config.ts'
import { createApiKey } from './keys.ts'
import { getBalance } from './balance.ts'

// Simple admin auth: a static secret in the header.
// In production, replace with proper auth (Supabase auth, etc.)
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? 'change-me-in-production'

export function requireAdmin(c: Context): boolean {
  const secret = c.req.header('x-admin-secret')
  return secret === ADMIN_SECRET
}

// ─── POST /admin/users ────────────────────────────────────────
// Create a new buyer and issue them an API key.
// In the MVP you call this manually after receiving Stripe payment.

const CreateUserSchema = z.object({
  email: z.string().email(),
})

export async function adminCreateUser(c: Context): Promise<Response> {
  if (!requireAdmin(c)) return adminUnauthorized()

  const body = await c.req.json().catch(() => null)
  const parsed = CreateUserSchema.safeParse(body)
  if (!parsed.success) {
    return jsonResponse(400, { error: parsed.error.flatten() })
  }

  const { email } = parsed.data

  // Create user
  const { data: user, error: userError } = await db
    .from('users')
    .insert({ email })
    .select()
    .single()

  if (userError) {
    if (userError.code === '23505') {
      return jsonResponse(409, { error: 'Email already registered' })
    }
    return jsonResponse(500, { error: userError.message })
  }

  // Init balance row
  await db.from('balances').insert({ user_id: user.id, cents: 0 })

  // Issue API key — this is the ONLY time the plaintext is available
  const apiKey = await createApiKey(user.id)

  return jsonResponse(201, {
    user_id:  user.id,
    email:    user.email,
    api_key:  apiKey,   // ← send this to the buyer immediately
    note:     'Store this key — it cannot be retrieved again.',
  })
}

// ─── GET /admin/users/:id/balance ────────────────────────────

export async function adminGetBalance(c: Context): Promise<Response> {
  if (!requireAdmin(c)) return adminUnauthorized()

  const userId = c.req.param('id')
  const cents   = await getBalance(userId)

  return jsonResponse(200, {
    user_id: userId,
    cents,
    dollars: (cents / 100).toFixed(2),
  })
}

// ─── GET /admin/stats ─────────────────────────────────────────
// Quick platform health check.

export async function adminStats(c: Context): Promise<Response> {
  if (!requireAdmin(c)) return adminUnauthorized()

  const [users, usage] = await Promise.all([
    db.from('users').select('id', { count: 'exact', head: true }),
    db.from('usage_log').select('cost_cents, margin_cents').limit(1000),
  ])

  const totalRevenueCents = usage.data?.reduce((s, r) => s + r.cost_cents, 0) ?? 0
  const totalMarginCents  = usage.data?.reduce((s, r) => s + r.margin_cents, 0) ?? 0

  return jsonResponse(200, {
    total_users:      users.count ?? 0,
    total_requests:   usage.data?.length ?? 0,
    revenue_cents:    totalRevenueCents,
    revenue_dollars:  (totalRevenueCents / 100).toFixed(2),
    margin_cents:     totalMarginCents,
    margin_dollars:   (totalMarginCents / 100).toFixed(2),
  })
}

// ─── Helpers ──────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function adminUnauthorized(): Response {
  return jsonResponse(403, { error: 'Invalid or missing x-admin-secret header' })
}
