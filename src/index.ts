import { Hono } from 'hono'
import { proxyMessages } from './proxy.ts'
import { handleStripeWebhook } from './webhook.ts'
import { adminCreateUser, adminGetBalance, adminStats } from './admin.ts'
import { config } from './config.ts'

const app = new Hono()

// ─── Health ───────────────────────────────────────────────────
app.get('/', (c) => c.json({
  service: 'Quotr Proxy',
  version: '0.1.0',
  status:  'operational',
  docs:    'https://quotr.io/docs',
}))

app.get('/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }))

// ─── Anthropic proxy (buyers hit this) ───────────────────────
// Drop-in replacement for https://api.anthropic.com
app.post('/v1/messages', proxyMessages)

// ─── Stripe webhook ───────────────────────────────────────────
app.post('/webhooks/stripe', handleStripeWebhook)

// ─── Admin (internal only — protect with firewall in production) ──
app.post('/admin/users',              adminCreateUser)
app.get('/admin/users/:id/balance',   adminGetBalance)
app.get('/admin/stats',               adminStats)

// ─── 404 ──────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: { type: 'not_found', message: 'Route not found' } }, 404))

// ─── Global error handler ─────────────────────────────────────
app.onError((err, c) => {
  console.error('[server] Unhandled error:', err)
  return c.json({ error: { type: 'internal_error', message: 'An unexpected error occurred.' } }, 500)
})

// ─── Start ────────────────────────────────────────────────────
const port = config.server.port
console.log(JSON.stringify({ event: 'startup', port, ts: new Date().toISOString() }))

export default {
  port,
  fetch: app.fetch,
}
