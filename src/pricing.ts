import { config } from './config.ts'

export interface TokenUsage {
  input_tokens:  number
  output_tokens: number
}

/**
 * Cost in USD cents that Anthropic charges us for this usage.
 * Uses integer arithmetic throughout to avoid floating-point drift.
 */
export function anthropicCostCents(usage: TokenUsage): number {
  const inputCents  = (usage.input_tokens  / 1_000_000) * config.anthropic.inputPricePerM  * 100
  const outputCents = (usage.output_tokens / 1_000_000) * config.anthropic.outputPricePerM * 100
  return Math.ceil(inputCents + outputCents)  // ceil so we never under-charge
}

/**
 * Cost in USD cents that we charge the buyer (Anthropic cost × markup).
 */
export function buyerCostCents(usage: TokenUsage): number {
  return Math.ceil(anthropicCostCents(usage) * config.pricing.markup)
}

/**
 * Our margin on a single request, in cents.
 */
export function marginCents(usage: TokenUsage): number {
  return buyerCostCents(usage) - anthropicCostCents(usage)
}

/**
 * Convert cents to a human-readable dollar string.
 */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(4)}`
}

/**
 * Minimum balance required before we allow a request.
 * We require at least 1 cent so near-zero accounts get a clean 402.
 */
export const MIN_BALANCE_CENTS = 1
