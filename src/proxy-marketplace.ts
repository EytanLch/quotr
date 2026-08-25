// src/proxy-marketplace.ts
// Upgraded proxy that routes requests through the marketplace.
// Drop-in replacement for proxy.ts once sellers are onboarded.

import type { Context } from 'hono'
import { config, rateLimiter } from './config.ts'
import { resolveKey } from './keys.ts'
import { hasSufficientBalance, deductBalance } from './balance.ts'
import { buyerCostCentsAtPrice, anthropicCostCents, marginCentsAtPrice } from './pricing-marketplace.ts'
import { getBestRoute, recordRouteUsage } from './router.ts'
import { logUsage } from './logger.ts'

const ALLOWED_MODELS = new Set([
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
])

export async function proxyMessagesMarketplace(c: Context): Promise<Response> {
  // ── 1. Authenticate buyer ─────────────────────────────────
  const authHeader = c.req.header('Authorization') ?? c.req.header('x-api-key')
  const rawKey     = authHeader?.replace(/^Bearer\s+/i, '').trim()

  if (!rawKey) return errRes(401, 'missing_api_key', 'Provide your Quotr API key in the Authorization header.')

  const keyRecord = await resolveKey(rawKey)
  if (!keyRecord) return errRes(401, 'invalid_api_key', 'This API key is invalid or has been revoked.')

  const { userId } = keyRecord

  // ── 2. Rate limit ─────────────────────────────────────────
  const { success, limit, reset } = await rateLimiter.limit(userId)
  if (!success) {
    return errRes(429, 'rate_limit_exceeded',
      `Rate limit: ${limit} req/min. Resets ${new Date(reset).toISOString()}.`,
      { 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0' }
    )
  }

  // ── 3. Parse body ─────────────────────────────────────────
  let body: Record<string, unknown>
  try { body = await c.req.json() }
  catch { return errRes(400, 'invalid_json', 'Request body must be valid JSON.') }

  const model = body.model as string | undefined
  if (!model)                    return errRes(400, 'missing_model', 'The "model" field is required.')
  if (!ALLOWED_MODELS.has(model)) return errRes(400, 'unsupported_model', `Model "${model}" is not available.`)

  // ── 4. Find best route (cheapest active seller for this model) ──
  const route = await getBestRoute(model)

  if (!route) {
    // No sellers available — fall back to master key if configured
    if (config.anthropic.masterKey) {
      return proxyWithKey(c, body, config.anthropic.masterKey, userId, model, null)
    }
    return errRes(503, 'no_supply', 'No sellers currently available for this model. Try again shortly.')
  }

  // ── 5. Balance check ──────────────────────────────────────
  const hasBalance = await hasSufficientBalance(userId)
  if (!hasBalance) {
    return errRes(402, 'insufficient_balance',
      'Your Quotr balance is too low. Top up at https://quotr.io/topup.')
  }

  // ── 6. Forward through seller's key ───────────────────────
  return proxyWithKey(c, body, route.apiKey, userId, model, route)
}

// ─── Core forwarding logic ────────────────────────────────────

async function proxyWithKey(
  c:       Context,
  body:    Record<string, unknown>,
  apiKey:  string,
  userId:  string,
  model:   string,
  route:   Awaited<ReturnType<typeof getBestRoute>>,
): Promise<Response> {
  const isStreaming = body.stream === true

  let upstreamRes: Response
  try {
    upstreamRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': config.anthropic.version,
        'content-type':      'application/json',
        ...(c.req.header('anthropic-beta')
          ? { 'anthropic-beta': c.req.header('anthropic-beta')! }
          : {}),
      },
      body: JSON.stringify(body),
    })
  } catch {
    return errRes(502, 'upstream_error', 'Failed to reach Anthropic. Please retry.')
  }

  // Pass through Anthropic errors transparently
  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text()
    return new Response(errBody, {
      status:  upstreamRes.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  return isStreaming
    ? handleStream(upstreamRes, userId, model, route)
    : handleNonStream(upstreamRes, userId, model, route)
}

// ─── Streaming ────────────────────────────────────────────────

async function handleStream(
  upstreamRes: Response,
  userId:      string,
  model:       string,
  route:       Awaited<ReturnType<typeof getBestRoute>>,
): Promise<Response> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer  = writable.getWriter()
  const decoder = new TextDecoder()
  let   buffer  = ''

  ;(async () => {
    try {
      const reader = upstreamRes.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
        buffer += decoder.decode(value, { stream: true })
      }
    } finally {
      await writer.close()
      const usage = extractUsage(buffer)
      if (usage) await meterRequest(userId, model, usage, route)
    }
  })()

  return new Response(readable, {
    headers: {
      'content-type':      'text/event-stream',
      'cache-control':     'no-cache',
      'x-accel-buffering': 'no',
    },
  })
}

// ─── Non-streaming ────────────────────────────────────────────

async function handleNonStream(
  upstreamRes: Response,
  userId:      string,
  model:       string,
  route:       Awaited<ReturnType<typeof getBestRoute>>,
): Promise<Response> {
  const data = await upstreamRes.json() as {
    usage?: { input_tokens: number; output_tokens: number }
  }

  if (data.usage) await meterRequest(userId, model, data.usage, route)

  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  })
}

// ─── Metering ─────────────────────────────────────────────────

async function meterRequest(
  userId:  string,
  model:   string,
  usage:   { input_tokens: number; output_tokens: number },
  route:   Awaited<ReturnType<typeof getBestRoute>>,
): Promise<void> {
  // Price is seller's ask if routed, else config markup
  const pricePerM  = route?.pricePerM ?? (config.anthropic.inputPricePerM * 100 * config.pricing.markup)
  const buyer      = buyerCostCentsAtPrice(usage, pricePerM)
  const cost       = anthropicCostCents(usage)
  const margin     = marginCentsAtPrice(usage, pricePerM)

  await deductBalance(userId, buyer)

  const logId = await logUsage({ userId, model, usage, buyerCents: buyer, anthropicCents: cost, marginCents: margin })

  // Record seller earnings if routed through marketplace
  if (route && logId) {
    await recordRouteUsage(route, usage.input_tokens, usage.output_tokens, logId)
  }
}

// ─── SSE usage extraction ─────────────────────────────────────

function extractUsage(raw: string): { input_tokens: number; output_tokens: number } | null {
  let input = 0, output = 0

  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const json = line.slice(6).trim()
    if (!json || json === '[DONE]') continue
    try {
      const ev = JSON.parse(json)
      if (ev.type === 'message_start'  && ev.message?.usage) input  = ev.message.usage.input_tokens ?? input
      if (ev.type === 'message_delta'  && ev.usage)           output = ev.usage.output_tokens ?? output
    } catch { /* ignore malformed */ }
  }

  return (input || output) ? { input_tokens: input, output_tokens: output } : null
}

// ─── Error helper ─────────────────────────────────────────────

function errRes(
  status:  number,
  code:    string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ error: { type: code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
