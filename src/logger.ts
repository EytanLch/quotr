import { db } from './config.ts'

interface UsageLogEntry {
  userId:         string
  model:          string
  usage:          { input_tokens: number; output_tokens: number }
  buyerCents:     number
  anthropicCents: number
  marginCents:    number
}

/**
 * Persist usage to Postgres and console.
 * Fire-and-forget: we don't block the response on this.
 * Returns the usage_log id so seller earnings can be linked.
 */
export async function logUsage(entry: UsageLogEntry): Promise<string | null> {
  const { userId, model, usage, buyerCents, anthropicCents, marginCents } = entry

  // Console log for Railway/Axiom ingestion
  console.log(JSON.stringify({
    event:           'usage',
    user_id:         userId,
    model,
    input_tokens:    usage.input_tokens,
    output_tokens:   usage.output_tokens,
    buyer_cents:     buyerCents,
    anthropic_cents: anthropicCents,
    margin_cents:    marginCents,
    ts:              new Date().toISOString(),
  }))

  // Persist to Postgres — now returns id for seller earnings linking
  const { data, error } = await db.from('usage_log').insert({
    user_id:         userId,
    model,
    input_tokens:    usage.input_tokens,
    output_tokens:   usage.output_tokens,
    cost_cents:      buyerCents,
    anthropic_cents: anthropicCents,
    margin_cents:    marginCents,
  }).select('id').single()

  if (error) {
    console.error('[logger] Failed to persist usage:', error.message)
    return null
  }

  // Also log a debit transaction for the ledger
  await db.from('transactions').insert({
    user_id:       userId,
    type:          'usage',
    cents:         -buyerCents,
    input_tokens:  usage.input_tokens,
    output_tokens: usage.output_tokens,
    meta:          { model },
  })

  return data?.id ?? null
}