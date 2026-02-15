-- HOT monetization and pricing schema
-- Run in Supabase SQL editor

alter table if exists track_requests add column if not exists payment_provider text;
alter table if exists track_requests add column if not exists payment_status text;
alter table if exists track_requests add column if not exists payment_order_id text;
alter table if exists track_requests add column if not exists payment_tx_id text;
alter table if exists track_requests add column if not exists payment_amount numeric(12,2);
alter table if exists track_requests add column if not exists payment_currency text;
alter table if exists track_requests add column if not exists payment_raw jsonb;
alter table if exists track_requests add column if not exists paid_at timestamptz;

create index if not exists idx_track_requests_payment_order_id on track_requests(payment_order_id);
create index if not exists idx_track_requests_payment_status on track_requests(payment_status);
create index if not exists idx_track_requests_payment_provider on track_requests(payment_provider);

create table if not exists pricing_catalog (
  sku text primary key,
  title text not null,
  description text,
  price numeric(12,2) not null,
  currency text not null default 'USDT',
  active boolean not null default true,
  limits_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_entitlements (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  sku text not null,
  source text not null default 'payment',
  remaining_uses integer not null default 1 check (remaining_uses >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_user_entitlements_user on user_entitlements(telegram_user_id);
create index if not exists idx_user_entitlements_sku on user_entitlements(sku);
create index if not exists idx_user_entitlements_expires on user_entitlements(expires_at);

create table if not exists user_trials (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  trial_key text not null,
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(telegram_user_id, trial_key)
);

create index if not exists idx_user_trials_user on user_trials(telegram_user_id);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  plan_sku text not null,
  status text not null default 'active',
  renew_at timestamptz not null,
  source text default 'hot',
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user on subscriptions(telegram_user_id);
create index if not exists idx_subscriptions_status on subscriptions(status);
create index if not exists idx_subscriptions_renew_at on subscriptions(renew_at);

create table if not exists promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  type text not null check (type in ('discount_percent', 'discount_amount', 'free_generation')),
  value numeric(12,2),
  sku text,
  max_uses integer check (max_uses is null or max_uses > 0),
  used_count integer not null default 0,
  per_user_limit integer not null default 1 check (per_user_limit > 0),
  active boolean not null default true,
  starts_at timestamptz,
  expires_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references promo_codes(id) on delete cascade,
  telegram_user_id bigint not null,
  request_id uuid,
  order_id text,
  discount_amount numeric(12,2) default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_promo_codes_code on promo_codes(code);
create index if not exists idx_promo_codes_active on promo_codes(active);
create index if not exists idx_promo_codes_validity on promo_codes(starts_at, expires_at);
create index if not exists idx_promo_redemptions_user on promo_redemptions(telegram_user_id);
create index if not exists idx_promo_redemptions_code_user on promo_redemptions(promo_code_id, telegram_user_id);

alter table if exists track_requests add column if not exists promo_code text;
alter table if exists track_requests add column if not exists promo_discount_amount numeric(12,2);
alter table if exists track_requests add column if not exists promo_type text;

insert into pricing_catalog (sku, title, description, price, currency, active, limits_json)
values
  ('single_song', 'Single song', 'Персональный звуковой ключ', 5.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('transit_energy_song', 'Transit energy song', 'Энергия дня (транзит)', 6.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('couple_song', 'Couple song', 'Песня совместимости пары', 8.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('deep_analysis_addon', 'Deep analysis', 'Дополнительный детальный разбор', 3.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('extra_regeneration', 'Extra regeneration', 'Повторная генерация трека', 2.49, 'USDT', true, '{"requests":1}'::jsonb),
  ('soul_basic_sub', 'Soul Basic', '3 трека/месяц + 10 soulchat', 14.99, 'USDT', true, '{"monthly_tracks":3,"monthly_soulchat":10,"kind":"subscription"}'::jsonb),
  ('soul_plus_sub', 'Soul Plus', '7 треков/месяц + 30 soulchat + приоритет', 24.99, 'USDT', true, '{"monthly_tracks":7,"monthly_soulchat":30,"priority":true,"kind":"subscription"}'::jsonb)
on conflict (sku) do update
set
  title = excluded.title,
  description = excluded.description,
  price = excluded.price,
  currency = excluded.currency,
  active = excluded.active,
  limits_json = excluded.limits_json,
  updated_at = now();

insert into promo_codes (code, type, value, sku, max_uses, per_user_limit, active, metadata)
values
  ('WELCOMEGIFT', 'free_generation', null, null, null, 1, true, '{"title":"Один бесплатный трек по промокоду"}'::jsonb),
  ('SOUL10', 'discount_percent', 10, null, null, 5, true, '{"title":"Скидка 10%"}'::jsonb)
on conflict (code) do update
set
  type = excluded.type,
  value = excluded.value,
  sku = excluded.sku,
  max_uses = excluded.max_uses,
  per_user_limit = excluded.per_user_limit,
  active = excluded.active,
  metadata = excluded.metadata,
  updated_at = now();
