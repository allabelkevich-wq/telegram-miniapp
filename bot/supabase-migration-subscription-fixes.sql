-- Миграция для исправления проблем с активацией подписок
-- Run in Supabase SQL editor

-- Таблица для логирования необработанных платежей (если webhook пришёл, но заявка не найдена)
create table if not exists unmatched_payments (
  id uuid primary key default gen_random_uuid(),
  memo text,
  request_id text,
  payload jsonb,
  received_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create index if not exists idx_unmatched_payments_received on unmatched_payments(received_at);
create index if not exists idx_unmatched_payments_resolved on unmatched_payments(resolved_at);
create index if not exists idx_unmatched_payments_memo on unmatched_payments(memo);
create index if not exists idx_unmatched_payments_request_id on unmatched_payments(request_id);

-- Таблица для логирования ошибок активации подписок (критично для диагностики)
create table if not exists subscription_activation_errors (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  request_id uuid,
  payment_order_id text,
  plan_sku text not null,
  error_message text not null,
  error_source text not null, -- 'webhook', 'stars_payment', 'claim', 'repair_on_read'
  payment_provider text, -- 'hot', 'stars'
  retry_count integer not null default 0,
  last_retry_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_sub_errors_user on subscription_activation_errors(telegram_user_id);
create index if not exists idx_sub_errors_created on subscription_activation_errors(created_at);
create index if not exists idx_sub_errors_resolved on subscription_activation_errors(resolved_at);
create index if not exists idx_sub_errors_request on subscription_activation_errors(request_id);
create index if not exists idx_sub_errors_order on subscription_activation_errors(payment_order_id);

-- Индексы для улучшения производительности запросов восстановления подписок
create index if not exists idx_track_requests_mode_payment on track_requests(mode, payment_status, created_at) where mode like 'sub_%';
create index if not exists idx_track_requests_user_payment on track_requests(telegram_user_id, payment_status, created_at);

-- Добавляем поле для отслеживания попыток активации подписки
alter table if exists track_requests add column if not exists subscription_activation_attempts integer default 0;
alter table if exists track_requests add column if not exists subscription_activated_at timestamptz;
