-- Quotr MVP schema
-- Run this in your Supabase SQL editor

-- ─── Users / buyers ──────────────────────────────────────────
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  created_at  timestamptz default now()
);

-- ─── API keys ────────────────────────────────────────────────
-- Each buyer gets one key. Stored hashed in DB; plaintext only
-- shown once at creation. We also cache in Redis for fast lookup.
create table if not exists api_keys (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references users(id) on delete cascade,
  key_hash    text unique not null,   -- sha256 of the raw key
  key_prefix  text not null,          -- first 12 chars for display
  created_at  timestamptz default now(),
  revoked_at  timestamptz
);

-- ─── Balances ────────────────────────────────────────────────
-- Credit balance in USD cents (integer avoids float rounding).
-- Redis mirrors this for hot-path reads; Postgres is the source of truth.
create table if not exists balances (
  user_id     uuid primary key references users(id) on delete cascade,
  cents       integer not null default 0,  -- USD cents
  updated_at  timestamptz default now()
);

-- ─── Transactions ────────────────────────────────────────────
-- Immutable ledger of every credit or debit.
create type tx_type as enum ('topup', 'usage', 'refund', 'payout');

create table if not exists transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  type            tx_type not null,
  cents           integer not null,        -- positive = credit, negative = debit
  input_tokens    integer,
  output_tokens   integer,
  stripe_id       text,                    -- payment_intent or payout id
  meta            jsonb,
  created_at      timestamptz default now()
);

create index on transactions(user_id, created_at desc);

-- ─── Usage log ───────────────────────────────────────────────
-- Per-request log for auditing and seller credit calculation.
create table if not exists usage_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id),
  model           text not null,
  input_tokens    integer not null,
  output_tokens   integer not null,
  cost_cents      integer not null,        -- what buyer was charged
  anthropic_cents integer not null,        -- what it actually cost us
  margin_cents    integer not null,        -- our profit on this request
  created_at      timestamptz default now()
);

create index on usage_log(user_id, created_at desc);
create index on usage_log(created_at desc);

-- ─── Stripe events (idempotency) ─────────────────────────────
create table if not exists stripe_events (
  id          text primary key,   -- Stripe event id
  processed_at timestamptz default now()
);

-- ─── Row level security ──────────────────────────────────────
-- We use the service_role key server-side so RLS doesn't block us,
-- but enabling it is good hygiene.
alter table users         enable row level security;
alter table api_keys      enable row level security;
alter table balances      enable row level security;
alter table transactions  enable row level security;
alter table usage_log     enable row level security;
