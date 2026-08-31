// src/index-marketplace.ts
// Full Quotr marketplace server.
// Extends the MVP with seller onboarding, listings, and dynamic routing.

import { Hono } from 'hono'
import { proxyMessagesMarketplace } from './proxy-marketplace.ts'
import { handleStripeWebhook } from './webhook.ts'
import { adminCreateUser, adminGetBalance, adminStats } from './admin.ts'
import {
  sellerRegister,
  sellerCreateListing,
  sellerGetListings,
  sellerReverify,
  getMarket,
} from './seller.ts'
import { config } from './config.ts'

const app = new Hono()

// CORS — allow requests from Vercel frontend
app.use('*', async (c, next) => {
  await next()
  c.header('Access-Control-Allow-Origin', 'https://quotr-exchange.vercel.app')
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
})

app.options('*', (c) => c.text('', 204))
// ─── Health ───────────────────────────────────────────────────
app.get('/',       (c) => c.json({ service: 'Quotr', version: '0.2.0', status: 'operational' }))
app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// ─── Anthropic-compatible proxy ───────────────────────────────
app.post('/v1/messages', proxyMessagesMarketplace)

// ─── Marketplace — public ────────────────────────────────────
// GET /market?model=claude-haiku-4-5
// Returns live order book — cheapest listings first
app.get('/market', getMarket)

// ─── Seller routes ────────────────────────────────────────────
// POST /sellers/register       → onboard a new seller
// POST /sellers/listings       → create a listing
// GET  /sellers/:id/listings   → view seller's listings + earnings
// POST /sellers/:id/reverify   → re-verify key and refresh balance
app.post('/sellers/register',          sellerRegister)
app.post('/sellers/listings',          sellerCreateListing)
app.get('/sellers/:id/listings',       sellerGetListings)
app.post('/sellers/:id/reverify',      sellerReverify)

// ─── Stripe webhook ───────────────────────────────────────────
app.post('/webhooks/stripe', handleStripeWebhook)

// ─── Admin ────────────────────────────────────────────────────
app.post('/admin/users',            adminCreateUser)
app.get('/admin/users/:id/balance', adminGetBalance)
app.get('/admin/stats',             adminStats)

// ─── Errors ───────────────────────────────────────────────────
app.notFound((c) => c.json({ error: { type: 'not_found' } }, 404))
app.onError((err, c) => {
  console.error('[server]', err)
  return c.json({ error: { type: 'internal_error' } }, 500)
})

const port = config.server.port
console.log(JSON.stringify({ event: 'startup', version: '0.2.0', port, ts: new Date().toISOString() }))

export default { port, fetch: app.fetch }
