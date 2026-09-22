// src/account.ts
// Two things:
// 1. GET /v1/account — returns buyer's balance + usage stats + transactions
// 2. POST /api/provision — called by Stripe webhook to auto-create user + email key

import type { Context } from 'hono'
import { db } from './config.ts'
import { resolveKey, createApiKey } from './keys.ts'
import { getBalance } from './balance.ts'

// ─── GET /v1/account ─────────────────────────────────────────
// Returns balance, usage stats, and recent transactions.
// Called by the balance.html page and the chat UI.

export async function getAccount(c: Context): Promise<Response> {
  const authHeader = c.req.header('Authorization') ?? c.req.header('x-api-key')
  const rawKey     = authHeader?.replace(/^Bearer\s+/i, '').trim()

  if (!rawKey) return json(401, { error: 'missing_api_key' })

  const keyRecord = await resolveKey(rawKey)
  if (!keyRecord) return json(401, { error: 'invalid_api_key' })

  const { userId } = keyRecord

  // Fetch balance, usage stats, and recent transactions in parallel
  const [cents, usageStats, transactions] = await Promise.all([
    getBalance(userId),
    getUsageStats(userId),
    getRecentTransactions(userId),
  ])

  return json(200, {
    cents,
    dollars:              (cents / 100).toFixed(4),
    total_spent_cents:    usageStats.totalSpent,
    total_calls:          usageStats.totalCalls,
    total_input_tokens:   usageStats.totalInput,
    total_output_tokens:  usageStats.totalOutput,
    transactions,
  })
}

async function getUsageStats(userId: string) {
  const { data } = await db
    .from('usage_log')
    .select('input_tokens, output_tokens, cost_cents')
    .eq('user_id', userId)

  const rows = data ?? []
  return {
    totalSpent:  rows.reduce((s, r) => s + r.cost_cents, 0),
    totalCalls:  rows.length,
    totalInput:  rows.reduce((s, r) => s + r.input_tokens, 0),
    totalOutput: rows.reduce((s, r) => s + r.output_tokens, 0),
  }
}

async function getRecentTransactions(userId: string) {
  const { data } = await db
    .from('transactions')
    .select('type, cents, meta, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)

  return data ?? []
}

// ─── POST /api/provision ─────────────────────────────────────
// Called internally after a confirmed Stripe payment.
// Creates the user account, issues an API key, sends email.
// This is the automated version of the manual admin curl flow.

export async function provisionUser(c: Context): Promise<Response> {
  // Verify this is called from our own webhook (internal secret)
  const secret = c.req.header('x-provision-secret')
  if (secret !== process.env.PROVISION_SECRET) {
    return json(403, { error: 'unauthorized' })
  }

  const { email, cents, stripe_id } = await c.req.json()

  if (!email || !cents) return json(400, { error: 'email and cents required' })

  // Check if user already exists
  let userId: string
  const { data: existing } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .single()

  if (existing) {
    userId = existing.id
  } else {
    const { data: newUser, error } = await db
      .from('users')
      .insert({ email })
      .select()
      .single()

    if (error) return json(500, { error: error.message })
    userId = newUser.id
    await db.from('balances').insert({ user_id: userId, cents: 0 })
  }

  // Credit balance
  await db.rpc('credit_balance', { p_user_id: userId, p_cents: cents })

  // Record transaction
  await db.from('transactions').insert({
    user_id:   userId,
    type:      'topup',
    cents,
    stripe_id: stripe_id ?? null,
  })

  // Issue API key
  const apiKey = await createApiKey(userId)

  // Send email with key
  await sendKeyEmail(email, apiKey, cents)

  return json(200, { user_id: userId, api_key: apiKey, email })
}

// ─── Email sending via Resend ─────────────────────────────────
// Resend is free for 100 emails/day. Sign up at resend.com.
// Add RESEND_API_KEY to your Railway env vars.

async function sendKeyEmail(email: string, apiKey: string, cents: number): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping email delivery')
    return
  }

  const dollars  = (cents / 100).toFixed(2)
  const proxyUrl = process.env.PROXY_URL ?? 'https://quotr-production-09ac.up.railway.app'

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#0D0D0D;color:#F0F0E8;font-family:monospace;padding:40px;max-width:520px;margin:0 auto;">
  <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px;">
    QUOT<span style="color:#00FF88">R</span>
  </h1>
  <p style="color:#888880;margin-bottom:32px;">Your API key is ready.</p>

  <div style="background:#141414;border:0.5px solid rgba(255,255,255,0.13);border-radius:10px;padding:24px;margin-bottom:24px;">
    <p style="font-size:11px;color:#555550;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Your API key</p>
    <p style="font-family:monospace;font-size:13px;color:#00FF88;word-break:break-all;background:#1C1C1C;padding:12px;border-radius:6px;">
      ${apiKey}
    </p>
    <p style="font-size:12px;color:#888880;margin-top:8px;">Balance: $${dollars} — store this key safely, it won't be shown again.</p>
  </div>

  <div style="background:#141414;border:0.5px solid rgba(255,255,255,0.13);border-radius:10px;padding:24px;margin-bottom:24px;">
    <p style="font-size:11px;color:#555550;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Start in 60 seconds</p>

    <p style="font-size:12px;color:#888880;margin-bottom:6px;">Option 1 — Chat interface (easiest):</p>
    <p style="font-family:monospace;font-size:12px;color:#00FF88;background:#1C1C1C;padding:10px;border-radius:4px;margin-bottom:16px;">
      <a href="${proxyUrl.replace('quotr-production-09ac.up.railway.app', 'quotr-exchange.vercel.app')}/chat.html" style="color:#00FF88;">quotr.io/chat</a>
    </p>

    <p style="font-size:12px;color:#888880;margin-bottom:6px;">Option 2 — Python (one line change):</p>
    <p style="font-family:monospace;font-size:12px;color:#F0F0E8;background:#1C1C1C;padding:10px;border-radius:4px;margin-bottom:16px;white-space:pre;">client = anthropic.Anthropic(
  api_key  = "${apiKey}",
  base_url = "${proxyUrl}"
)</p>

    <p style="font-size:12px;color:#888880;margin-bottom:6px;">Option 3 — curl:</p>
    <p style="font-family:monospace;font-size:12px;color:#F0F0E8;background:#1C1C1C;padding:10px;border-radius:4px;white-space:pre;">curl ${proxyUrl}/v1/messages \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-haiku-4-5","max_tokens":100,
       "messages":[{"role":"user","content":"Hello!"}]}'</p>
  </div>

  <p style="font-size:12px;color:#555550;">
    Questions? Reply to this email or visit
    <a href="https://quotr.io/docs" style="color:#888880;">quotr.io/docs</a>
  </p>
</body>
</html>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'Quotr <keys@quotr.io>',
        to:      [email],
        subject: 'Your Quotr API key',
        html,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[email] Resend error:', err)
    } else {
      console.log(`[email] Key delivered to ${email}`)
    }
  } catch (err) {
    console.error('[email] Failed to send:', err)
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
