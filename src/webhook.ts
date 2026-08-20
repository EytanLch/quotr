import type { Context } from 'hono'
import { stripe, config, db } from './config.ts'
import { creditBalance } from './balance.ts'

/**
 * POST /webhooks/stripe
 *
 * Handles Stripe events. Currently processes:
 *   - checkout.session.completed  → top-up flow
 *   - payment_intent.succeeded    → direct charge (future)
 *
 * Idempotent: we record processed event IDs to avoid double-crediting.
 *
 * Setup:
 *   1. Create a Stripe product: "Quotr Credits"
 *   2. Create a Stripe payment link pointing to your /webhooks/stripe
 *   3. Set metadata on the payment link: { quotr_user_id: "..." }
 *      (In MVP: you manually set this per buyer. In v2: auto-populated.)
 */
export async function handleStripeWebhook(c: Context): Promise<Response> {
  const signature = c.req.header('stripe-signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  // Read raw body — Stripe signature verification requires the exact bytes
  const rawBody = await c.req.text()

  let event: ReturnType<typeof stripe.webhooks.constructEvent>
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret)
  } catch (err) {
    console.error('[stripe] Webhook signature verification failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  // ── Idempotency check ─────────────────────────────────────
  const { data: existing } = await db
    .from('stripe_events')
    .select('id')
    .eq('id', event.id)
    .single()

  if (existing) {
    return new Response('Already processed', { status: 200 })
  }

  // ── Handle events ─────────────────────────────────────────
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session)
        break

      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent)
        break

      default:
        // Ignore other events
        break
    }

    // Record as processed
    await db.from('stripe_events').insert({ id: event.id })

  } catch (err) {
    console.error(`[stripe] Failed to process event ${event.id}:`, err)
    // Return 500 so Stripe retries
    return new Response('Processing failed', { status: 500 })
  }

  return new Response('OK', { status: 200 })
}

// ─── Checkout session ─────────────────────────────────────────
// Flow:
//   1. You create a Stripe Payment Link for each buyer, passing
//      their user_id in the metadata field.
//   2. Buyer pays.
//   3. Stripe fires checkout.session.completed.
//   4. We credit their balance.

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  // Try session metadata first, then payment link metadata
  let userId = session.metadata?.tokenex_user_id

  // If not on session, fetch from the payment link directly
  if (!userId && session.payment_link) {
    const paymentLink = await stripe.paymentLinks.retrieve(session.payment_link as string)
    userId = paymentLink.metadata?.tokenex_user_id
  }

  if (!userId) {
    console.warn('[stripe] Missing tokenex_user_id in both session and payment link metadata', session.id)
    return
  }

  const amountCents = session.amount_total
  if (!amountCents || amountCents <= 0) return

  await creditBalance(userId, amountCents, session.payment_intent as string ?? session.id)

  console.log(JSON.stringify({
    event:      'topup',
    user_id:    userId,
    cents:      amountCents,
    session_id: session.id,
    ts:         new Date().toISOString(),
  }))
}

// ─── Payment intent ───────────────────────────────────────────
// For direct charges (phase 2 — buyer API triggers payment).

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent): Promise<void> {
  const userId = intent.metadata?.quotr_user_id
  if (!userId) return

  await creditBalance(userId, intent.amount, intent.id)
}
