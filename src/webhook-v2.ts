// src/webhook-v2.ts
// Upgraded Stripe webhook that auto-provisions users after payment.
// Replaces webhook.ts — same structure, adds auto-provisioning.

import type { Context } from 'hono'
import { stripe, config, db } from './config.ts'
import { getBalance, creditBalance } from './balance.ts'
import { createApiKey } from './keys.ts'

export async function handleStripeWebhookV2(c: Context): Promise<Response> {
  const signature = c.req.header('stripe-signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  const rawBody = await c.req.text()

  let event: any
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret)
  } catch (err) {
    console.error('[stripe] Signature verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  // Idempotency check
  const { data: existing } = await db
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .single()

  if (existing) return new Response('Already processed', { status: 200 })

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object)
        break
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object)
        break
    }

    await db.from('stripe_events').insert({ id: event.id })

  } catch (err) {
    console.error(`[stripe] Failed to process ${event.id}:`, err)
    return new Response('Processing failed', { status: 500 })
  }

  return new Response('OK', { status: 200 })
}

async function handleCheckoutCompleted(session: any): Promise<void> {
  // Get user_id from metadata (existing buyers) or email (new buyers)
  let userId = session.metadata?.tokenex_user_id

  // Try payment link metadata if not on session
  if (!userId && session.payment_link) {
    const paymentLink = await stripe.paymentLinks.retrieve(session.payment_link)
    userId = paymentLink.metadata?.tokenex_user_id
  }

  const email       = session.customer_details?.email ?? session.metadata?.email
  const amountCents = session.amount_total
  const stripeId    = session.payment_intent ?? session.id

  if (!amountCents || amountCents <= 0) return

  // ── Existing user: just credit balance ────────────────────
  if (userId) {
    await creditBalance(userId, amountCents, stripeId)
    console.log(JSON.stringify({ event: 'topup', user_id: userId, cents: amountCents }))
    return
  }

  // ── New user: auto-provision ───────────────────────────────
  if (!email) {
    console.warn('[stripe] No user_id or email — cannot provision:', session.id)
    return
  }

  // Check if user exists by email
  const { data: existingUser } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .single()

  if (existingUser) {
    // Existing user — just top up
    await creditBalance(existingUser.id, amountCents, stripeId)
    console.log(JSON.stringify({ event: 'topup_existing', user_id: existingUser.id, cents: amountCents }))
    return
  }

  // New user — create account, issue key, send email
  const { data: newUser, error } = await db
    .from('users')
    .insert({ email })
    .select()
    .single()

  if (error) {
    console.error('[stripe] Failed to create user:', error.message)
    return
  }

  await db.from('balances').insert({ user_id: newUser.id, cents: 0 })
  await creditBalance(newUser.id, amountCents, stripeId)

  const apiKey = await createApiKey(newUser.id)

  // Send key via email
  await deliverKey(email, apiKey, amountCents)

  console.log(JSON.stringify({
    event:   'new_user_provisioned',
    user_id: newUser.id,
    email,
    cents:   amountCents,
  }))
}

async function handlePaymentIntentSucceeded(intent: any): Promise<void> {
  const userId = intent.metadata?.tokenex_user_id
  if (!userId) return
  await creditBalance(userId, intent.amount, intent.id)
}

// ─── Email delivery ───────────────────────────────────────────
async function deliverKey(email: string, apiKey: string, cents: number): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) {
    console.warn(`[email] No RESEND_API_KEY — key for ${email}: ${apiKey}`)
    return
  }

  const dollars  = (cents / 100).toFixed(2)
  const proxyUrl = process.env.PROXY_URL ?? 'https://quotr-production-09ac.up.railway.app'
  const siteUrl  = process.env.SITE_URL  ?? 'https://quotr-exchange.vercel.app'

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="background:#0D0D0D;color:#F0F0E8;font-family:monospace;padding:40px;max-width:520px;margin:0 auto;">
  <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:8px;">QUOT<span style="color:#00FF88">R</span></h1>
  <p style="color:#888880;margin-bottom:32px;">Your API key is ready. Balance: $${dollars}</p>

  <div style="background:#141414;border:0.5px solid rgba(255,255,255,0.13);border-radius:10px;padding:24px;margin-bottom:16px;">
    <p style="font-size:11px;color:#555550;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px;">Your API key — save this</p>
    <p style="font-family:monospace;font-size:13px;color:#00FF88;word-break:break-all;background:#1C1C1C;padding:12px;border-radius:6px;">${apiKey}</p>
  </div>

  <div style="background:#141414;border:0.5px solid rgba(255,255,255,0.13);border-radius:10px;padding:24px;margin-bottom:16px;">
    <p style="font-size:11px;color:#555550;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">3 ways to use it</p>

    <p style="font-size:12px;color:#888880;margin-bottom:4px;">1. Chat (easiest — no code):</p>
    <p style="margin-bottom:16px;"><a href="${siteUrl}/chat.html" style="color:#00FF88;font-size:12px;">${siteUrl}/chat.html</a></p>

    <p style="font-size:12px;color:#888880;margin-bottom:4px;">2. Python:</p>
    <p style="font-family:monospace;font-size:11px;color:#F0F0E8;background:#1C1C1C;padding:10px;border-radius:4px;margin-bottom:16px;white-space:pre;">import anthropic
client = anthropic.Anthropic(
    api_key="${apiKey}",
    base_url="${proxyUrl}"
)</p>

    <p style="font-size:12px;color:#888880;margin-bottom:4px;">3. Check balance anytime:</p>
    <p><a href="${siteUrl}/balance.html" style="color:#00FF88;font-size:12px;">${siteUrl}/balance.html</a></p>
  </div>

  <p style="font-size:11px;color:#555550;">Questions? Reply to this email. Docs: <a href="${siteUrl}/docs.html" style="color:#888880;">quotr.io/docs</a></p>
</body></html>`

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'Quotr <keys@quotr.io>',
        to: [process.env.RESEND_TEST_EMAIL ?? email],
        subject: `Your Quotr API key — $${dollars} balance ready`,
        html,
      })
    })
    console.log(`[email] Delivered to ${email}`)
  } catch (err) {
    console.error('[email] Failed:', err)
  }
}
