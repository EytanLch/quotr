-- ─────────────────────────────────────────────────────────────
-- Quotr Marketplace — schema additions
-- Run this AFTER the original schema.sql
-- ─────────────────────────────────────────────────────────────

-- ── Sellers ──────────────────────────────────────────────────
-- A seller is any user who lists their Anthropic API credits.
-- Their raw API key is NEVER stored — only the AES-256 encrypted form.

create table if not exists sellers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  -- Encrypted Anthropic API key (AES-256-GCM, base64 encoded)
  -- Format: iv:authTag:ciphertext (all base64)
  encrypted_key   text not null,
  key_hint        text not null,      -- last 4 chars of raw key for display e.g. "...xK9m"
  -- Verified balance at time of last check (in USD cents)
  verified_cents  integer not null default 0,
  verified_at     timestamptz,
  -- Listing state
  status          text not null default 'pending'
                  check (status in ('pending','active','paused','exhausted','expired')),
  created_at      timestamptz default now()
);

create index on sellers(user_id);
create index on sellers(status);

-- ── Listings ─────────────────────────────────────────────────
-- A listing is an offer to sell a specific number of tokens
-- at a specific price, expiring at a specific time.
-- One seller can have multiple listings (different models, prices).

create table if not exists listings (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid references sellers(id) on delete cascade,
  -- What's being sold
  model           text not null,           -- e.g. 'claude-haiku-4-5'
  -- Pricing
  ask_cents_per_m integer not null,        -- USD cents per 1M input tokens
  -- Inventory
  total_tokens    bigint not null,         -- total input tokens available
  used_tokens     bigint not null default 0,
  -- Expiry — seller sets this based on when their Anthropic credits expire
  expires_at      timestamptz not null,
  -- Auto-discount: if true, price decays 1% per hour in final 48h
  auto_discount   boolean not null default true,
  -- State
  status          text not null default 'active'
                  check (status in ('active','paused','exhausted','expired')),
  created_at      timestamptz default now()
);

create index on listings(status, model, ask_cents_per_m);
create index on listings(expires_at);
create index on listings(seller_id);

-- ── Routing table ─────────────────────────────────────────────
-- Maps a buyer's active purchase to a specific listing.
-- The proxy uses this to know which seller key to use.

create table if not exists buyer_routes (
  id              uuid primary key default gen_random_uuid(),
  buyer_id        uuid references users(id) on delete cascade,
  listing_id      uuid references listings(id) on delete cascade,
  -- Tokens purchased in this allocation
  purchased_tokens bigint not null,
  used_tokens      bigint not null default 0,
  -- Active until tokens exhausted or listing expires
  status          text not null default 'active'
                  check (status in ('active','exhausted','expired')),
  created_at      timestamptz default now(),
  expires_at      timestamptz not null
);

create index on buyer_routes(buyer_id, status);
create index on buyer_routes(listing_id, status);

-- ── Seller earnings ───────────────────────────────────────────
-- Immutable record of what each seller earned per request.

create table if not exists seller_earnings (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid references sellers(id),
  listing_id      uuid references listings(id),
  usage_log_id    uuid references usage_log(id),
  -- What the seller earned on this request
  earned_cents    integer not null,
  platform_cents  integer not null,   -- platform's cut
  created_at      timestamptz default now()
);

create index on seller_earnings(seller_id, created_at desc);

-- ── Verification log ──────────────────────────────────────────
-- Every time we ping Anthropic to verify a seller's key/balance.

create table if not exists verification_log (
  id              uuid primary key default gen_random_uuid(),
  seller_id       uuid references sellers(id),
  success         boolean not null,
  verified_cents  integer,
  error           text,
  checked_at      timestamptz default now()
);

-- ── Helper: get cheapest active listing for a model ───────────
-- Returns the listing with the lowest effective price
-- (accounting for auto-discount near expiry).
-- Called by the proxy on every request.

create or replace function get_best_listing(p_model text)
returns table (
  listing_id      uuid,
  seller_id       uuid,
  effective_price integer   -- cents per 1M tokens
) as $$
begin
  return query
  select
    l.id,
    l.seller_id,
    case
      -- Auto-discount: decay price 1% per hour in final 48h
      when l.auto_discount and l.expires_at < now() + interval '48 hours'
      then greatest(
        1,  -- floor of 1 cent per M
        l.ask_cents_per_m - (
          l.ask_cents_per_m *
          extract(epoch from (l.expires_at - now())) /
          (48 * 3600) *
          0.01
        )::integer
      )
      else l.ask_cents_per_m
    end as effective_price
  from listings l
  where
    l.model = p_model
    and l.status = 'active'
    and l.expires_at > now()
    and l.used_tokens < l.total_tokens
  order by effective_price asc
  limit 1;
end;
$$ language plpgsql;

-- ── Helper: deduct tokens from listing ───────────────────────

create or replace function deduct_listing_tokens(
  p_listing_id  uuid,
  p_tokens      bigint
) returns void as $$
begin
  update listings
  set
    used_tokens = used_tokens + p_tokens,
    status = case
      when used_tokens + p_tokens >= total_tokens then 'exhausted'
      else status
    end
  where id = p_listing_id;
end;
$$ language plpgsql;
