import type { Context } from 'hono'
import { config, rateLimiter } from './config.ts'
import { resolveKey } from './keys.ts'
import { hasSufficientBalance, deductBalance } from './balance.ts'
import { buyerCostCents, anthropicCostCents, marginCents } from './pricing.ts'
import { logUsage } from './logger.ts'

// Models we allow buyers to access. Expand as needed.
const ALLOWED_MODELS = new Set([
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'claude-3-opus-20240229',
])

/**
 * POST /v1/messages
 *
 * Drop-in replacement for the Anthropic API endpoint.
 * Buyers use this exactly as they would Anthropic directly —
 * same request shape, same response shape, same streaming format.
 *
 * Flow:
 *   1. Authenticate buyer API key
 *   2. Rate limit
 *   3. Validate request body
 *   4. Check buyer has balance
 *   5. Forward to Anthropic with master key
 *   6. Stream response back to buyer
 *   7. Meter usage and deduct balance post-completion
 */
export async function proxyMessages(c: Context): Promise<Response> {
  // ── 1. Authenticate ───────────────────────────────────────
  const authHeader = c.req.header('Authorization') ?? c.req.header('x-api-key')
  const rawKey = authHeader?.replace(/^Bearer\s+/i, '').trim()

  if (!rawKey) {
    return errorResponse(401, 'missing_api_key', 'Provide your Quotr API key in the Authorization header.')
  }

  const keyRecord = await resolveKey(rawKey)
  if (!keyRecord) {
    return errorResponse(401, 'invalid_api_key', 'This API key is invalid or has been revoked.')
  }

  const { userId } = keyRecord

  // ── 2. Rate limit ─────────────────────────────────────────
  const { success: withinLimit, limit, remaining, reset } = await rateLimiter.limit(userId)
  if (!withinLimit) {
    return errorResponse(429, 'rate_limit_exceeded',
      `Rate limit: ${limit} requests/minute. Resets at ${new Date(reset).toISOString()}.`,
      { 'X-RateLimit-Limit': String(limit), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(reset) }
    )
  }

  // ── 3. Parse and validate request body ────────────────────
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return errorResponse(400, 'invalid_json', 'Request body must be valid JSON.')
  }

  const model = body.model as string | undefined
  if (!model) return errorResponse(400, 'missing_model', 'The "model" field is required.')
  if (!ALLOWED_MODELS.has(model)) {
    return errorResponse(400, 'unsupported_model',
      `Model "${model}" is not available on Quotr. Supported: ${[...ALLOWED_MODELS].join(', ')}.`)
  }

  // ── 4. Balance check ──────────────────────────────────────
  const hasBalance = await hasSufficientBalance(userId)
  if (!hasBalance) {
    return errorResponse(402, 'insufficient_balance',
      'Your Quotr balance is too low. Top up at https://quotr.io/topup.')
  }

  // ── 5. Forward to Anthropic ───────────────────────────────
  const isStreaming = body.stream === true

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
      method:  'POST',
      headers: {
        'x-api-key':         config.anthropic.masterKey,
        'anthropic-version': config.anthropic.version,
        'content-type':      'application/json',
        // Pass through any anthropic-beta headers the buyer sends
        ...(c.req.header('anthropic-beta') ? { 'anthropic-beta': c.req.header('anthropic-beta')! } : {}),
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('[proxy] Anthropic fetch error:', err)
    return errorResponse(502, 'upstream_error', 'Failed to reach Anthropic. Please retry.')
  }

  // If Anthropic returned an error, pass it through transparently
  if (!upstreamRes.ok) {
    const errBody = await upstreamRes.text()
    return new Response(errBody, {
      status:  upstreamRes.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  // ── 6 + 7. Stream response and meter post-completion ──────
  if (isStreaming) {
    return handleStreamingResponse(upstreamRes, userId, model)
  } else {
    return handleNonStreamingResponse(upstreamRes, userId, model)
  }
}

// ─── Streaming path ──────────────────────────────────────────
// We pipe Anthropic's SSE stream directly to the buyer while
// watching for the final [DONE] event that contains usage stats.

async function handleStreamingResponse(
  upstreamRes: Response,
  userId:      string,
  model:       string
): Promise<Response> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  // Collect SSE chunks to extract usage from the final event
  let usageBuffer = ''

  // Process stream in background — don't await, let it pipe
  ;(async () => {
    try {
      const reader = upstreamRes.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // Pass chunk through to buyer
        await writer.write(value)

        // Accumulate for usage parsing
        usageBuffer += decoder.decode(value, { stream: true })
      }
    } catch (err) {
      console.error('[proxy] Stream error:', err)
    } finally {
      await writer.close()

      // Meter after stream completes
      const usage = extractUsageFromSSE(usageBuffer)
      if (usage) {
        await meterAndDeduct(userId, model, usage)
      } else {
        console.warn(`[proxy] Could not extract usage for user ${userId} — manual reconciliation needed`)
      }
    }
  })()

  return new Response(readable, {
    headers: {
      'content-type':      'text/event-stream',
      'cache-control':     'no-cache',
      'x-accel-buffering': 'no',   // prevents nginx from buffering SSE
    },
  })
}

// ─── Non-streaming path ───────────────────────────────────────

async function handleNonStreamingResponse(
  upstreamRes: Response,
  userId:      string,
  model:       string
): Promise<Response> {
  const data = await upstreamRes.json() as { usage?: { input_tokens: number; output_tokens: number } }

  if (data.usage) {
    await meterAndDeduct(userId, model, data.usage)
  }

  return new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  })
}

// ─── Metering ─────────────────────────────────────────────────

async function meterAndDeduct(
  userId: string,
  model:  string,
  usage:  { input_tokens: number; output_tokens: number }
): Promise<void> {
  const buyer    = buyerCostCents(usage)
  const cost     = anthropicCostCents(usage)
  const margin   = marginCents(usage)

  await deductBalance(userId, buyer)
  await logUsage({ userId, model, usage, buyerCents: buyer, anthropicCents: cost, marginCents: margin })
}

// ─── SSE usage extraction ─────────────────────────────────────
// Anthropic streams a final event like:
// data: {"type":"message_delta","usage":{"input_tokens":X,"output_tokens":Y}}
// followed by:
// data: {"type":"message_stop"}
// The usage appears in the message_delta event.

function extractUsageFromSSE(raw: string): { input_tokens: number; output_tokens: number } | null {
  const lines = raw.split('\n')
  let inputTokens = 0
  let outputTokens = 0

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const json = line.slice(6).trim()
    if (json === '[DONE]' || !json) continue

    try {
      const event = JSON.parse(json)
      // message_start contains input token count
      if (event.type === 'message_start' && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? inputTokens
      }
      // message_delta contains output token count
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens ?? outputTokens
      }
    } catch {
      // Ignore malformed SSE lines
    }
  }

  if (inputTokens === 0 && outputTokens === 0) return null
  return { input_tokens: inputTokens, output_tokens: outputTokens }
}

// ─── Error helper ─────────────────────────────────────────────

function errorResponse(
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
