// src/pricing-marketplace.ts
// Pricing utilities for the marketplace proxy.
// Unlike the MVP's fixed markup, prices here float per seller listing.

export interface TokenUsage {
  input_tokens:  number
  output_tokens: number
}

// Anthropic's actual cost to us — fixed
const ANTHROPIC_INPUT_PER_M_CENTS  = 3    // $3.00 / 1M input tokens
const ANTHROPIC_OUTPUT_PER_M_CENTS = 15   // $15.00 / 1M output tokens

/**
 * What Anthropic charges us for this request (our cost floor).
 */
export function anthropicCostCents(usage: TokenUsage): number {
  return Math.ceil(
    (usage.input_tokens  / 1_000_000) * ANTHROPIC_INPUT_PER_M_CENTS +
    (usage.output_tokens / 1_000_000) * ANTHROPIC_OUTPUT_PER_M_CENTS
  )
}

/**
 * What the buyer pays at a given seller's price per million tokens.
 * We add 2% platform fee on top of the seller's ask.
 */
export function buyerCostCentsAtPrice(usage: TokenUsage, sellerPricePerM: number): number {
  const sellerCents = Math.ceil((usage.input_tokens / 1_000_000) * sellerPricePerM)
  return Math.ceil(sellerCents * 1.02)  // +2% platform fee
}

/**
 * Platform margin at a given seller price.
 * = buyer pays - anthropic costs - seller earns
 * At distressed prices this may be negative — platform absorbs
 * the difference to guarantee best execution for buyers.
 *
 * In practice, we enforce a floor: sellerPrice >= anthropic cost.
 */
export function marginCentsAtPrice(usage: TokenUsage, sellerPricePerM: number): number {
  return buyerCostCentsAtPrice(usage, sellerPricePerM) - anthropicCostCents(usage)
}

/**
 * Minimum viable seller ask price — must cover Anthropic's cost.
 * Sellers who price below this would cause us to lose money routing
 * through their key. We enforce this at listing creation time.
 */
export const MIN_ASK_CENTS_PER_M = ANTHROPIC_INPUT_PER_M_CENTS  // $3/M floor

/**
 * Anthropic retail prices for display / comparison.
 */
export const ANTHROPIC_RETAIL: Record<string, number> = {
  'claude-haiku-4-5':            300,   // $3.00/M
  'claude-sonnet-4-5':           300,   // $3.00/M
  'claude-opus-4-5':             1500,  // $15.00/M
  'claude-3-5-sonnet-20241022':  300,
  'claude-3-5-haiku-20241022':   80,    // $0.80/M
}
