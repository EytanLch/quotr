import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import Stripe from 'stripe'

// ─── Environment ──────────────────────────────────────────────
function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

export const config = {
  anthropic: {
    masterKey: requireEnv('ANTHROPIC_MASTER_KEY'),
    baseUrl: 'https://api.anthropic.com',
    version: '2023-06-01',
    // USD per million tokens — Anthropic's current pricing
    inputPricePerM:  parseFloat(process.env.ANTHROPIC_INPUT_PRICE_PER_M  ?? '3.00'),
    outputPricePerM: parseFloat(process.env.ANTHROPIC_OUTPUT_PRICE_PER_M ?? '15.00'),
  },
  pricing: {
    // Multiplier applied on top of Anthropic cost (1.20 = 20% markup)
    markup:      parseFloat(process.env.PLATFORM_MARKUP ?? '1.20'),
    // Platform fee taken from seller earnings
    platformFee: parseFloat(process.env.PLATFORM_FEE   ?? '0.02'),
  },
  stripe: {
    secretKey:     requireEnv('STRIPE_SECRET_KEY'),
    webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET'),
  },
  server: {
    port: parseInt(process.env.PORT ?? '3000'),
  },
}

// ─── Supabase (service role — bypasses RLS, server-side only) ─
export const db = createClient(
  requireEnv('SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_KEY'),
  { auth: { persistSession: false } }
)

// ─── Upstash Redis ────────────────────────────────────────────
export const redis = Redis.fromEnv()

// ─── Rate limiter: 60 requests per minute per user ────────────
export const rateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '1 m'),
  analytics: true,
  prefix: 'quotr:rl',
})

// ─── Stripe ───────────────────────────────────────────────────
export const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2024-04-10',
  typescript: true,
})
