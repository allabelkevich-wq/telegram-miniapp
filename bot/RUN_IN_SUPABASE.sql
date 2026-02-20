-- =============================================================================
-- ВЫПОЛНИТЬ ВСЕ МИГРАЦИИ ОДНИМ ЗАПУСКОМ
-- Supabase → SQL Editor → New query → вставь этот файл целиком → Run.
-- Если таблица track_requests уже есть — скрипт безопасен (create if not exists, add column if not exists).
-- Перед запуском: сделай бэкап (Project Settings → Backups → Create manual backup).
-- =============================================================================

-- 1. Схема: track_requests + astro_snapshots + базовые колонки
create table if not exists track_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  name text,
  birthdate date,
  birthplace text,
  birthtime time,
  birthtime_unknown boolean default false,
  gender text,
  language text,
  request text,
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_track_requests_telegram_user on track_requests(telegram_user_id);
create index if not exists idx_track_requests_status on track_requests(status);
create index if not exists idx_track_requests_created on track_requests(created_at desc);
comment on table track_requests is 'Заявки из Mini App на создание звукового ключа';
alter table track_requests disable row level security;

create table if not exists astro_snapshots (
  id uuid primary key default gen_random_uuid(),
  track_request_id uuid not null references track_requests(id) on delete cascade,
  snapshot_text text not null,
  snapshot_json jsonb,
  birth_lat double precision,
  birth_lon double precision,
  birth_utc timestamptz,
  time_unknown boolean default false,
  created_at timestamptz default now()
);
create unique index if not exists idx_astro_snapshots_track_request on astro_snapshots(track_request_id);
create index if not exists idx_astro_snapshots_created on astro_snapshots(created_at desc);
comment on table astro_snapshots is 'Натальные карты для заявок';

alter table track_requests add column if not exists astro_snapshot_id uuid references astro_snapshots(id);
alter table track_requests add column if not exists language text;
alter table track_requests add column if not exists lyrics text;
alter table track_requests add column if not exists title text;
alter table track_requests add column if not exists audio_url text;
alter table track_requests add column if not exists suno_task_id text;
alter table track_requests add column if not exists error_message text;

-- 2. Расшифровка карты (detailed_analysis, analysis_paid)
alter table track_requests add column if not exists detailed_analysis text;
alter table track_requests add column if not exists analysis_paid boolean default false;
comment on column track_requests.detailed_analysis is 'Подробный анализ натальной карты от DeepSeek';
comment on column track_requests.analysis_paid is 'Оплачена ли детальная расшифровка';

-- 3. Промпты (prompt_templates)
create table if not exists prompt_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  variables text[] default '{}',
  is_active boolean not null default true,
  version int not null default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists idx_prompt_templates_name_active on prompt_templates(name) where is_active = true;
create index if not exists idx_prompt_templates_name on prompt_templates(name);
create index if not exists idx_prompt_templates_active on prompt_templates(is_active) where is_active = true;
comment on table prompt_templates is 'Шаблоны промптов для DeepSeek/Suno';
alter table prompt_templates disable row level security;
create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;
drop trigger if exists prompt_templates_updated_at on prompt_templates;
create trigger prompt_templates_updated_at before update on prompt_templates for each row execute function set_updated_at();
-- Начальные шаблоны (только если ещё нет активного с таким name)
insert into prompt_templates (name, body, variables, is_active, version)
select v.name, v.body, v.variables, true, 1
from (values
  (
    'deepseek_archetype_v1'::text,
    'По натальной карте ниже выдели архетип человека в поэтическом образе (без астрологических терминов), ключевые энергии (2–3 планеты/дома/аспекта), историю души: Дар → Тень → Превращение → Миссия. Ответь структурированно: Архетип, Ключевые энергии, История души, Музыкальный контекст (настроение, метафоры).' || E'\n\n' || 'Натальная карта:' || E'\n' || '{{astro_snapshot}}' || E'\n\n' || 'Имя: {{name}}' || E'\n' || 'Запрос пользователя: {{request}}',
    array['astro_snapshot', 'name', 'request']
  ),
  (
    'deepseek_lyrics_v1'::text,
    'Напиши текст песни на русском языке по архетипу и запросу. Структура: куплет (4–6 строк), припев (4–6 строк), бридж, при необходимости инструментальный проигрыш и аутро. Стиль — персонализированный, без общих фраз. Только текст, без разметки [verse]/[chorus] в финале — просто строки.' || E'\n\n' || 'Архетип и контекст:' || E'\n' || '{{archetype}}' || E'\n\n' || 'Имя: {{name}}' || E'\n' || 'Запрос: {{request}}',
    array['archetype', 'name', 'request']
  ),
  (
    'deepseek_title_v1'::text,
    'Предложи одно короткое запоминающееся название трека (на русском) по архетипу и запросу. Только название, без кавычек и пояснений.' || E'\n\n' || 'Архетип:' || E'\n' || '{{archetype}}' || E'\n\n' || 'Запрос: {{request}}',
    array['archetype', 'request']
  ),
  (
    'suno_config_v1'::text,
    '{"style": "indie pop, atmospheric", "mood": "вдохновляющий, личный", "language": "Russian"}',
    array[]::text[]
  )
) as v(name, body, variables)
where not exists (select 1 from prompt_templates pt where pt.name = v.name and pt.is_active = true);

-- 4. Статус генерации, ответ DeepSeek, тип запроса, индексы
alter table track_requests add column if not exists generation_status text default 'pending';
alter table track_requests add column if not exists deepseek_response text;
alter table track_requests add column if not exists request_type text default 'general';
create index if not exists idx_track_requests_generation_status on track_requests (generation_status);
create index if not exists idx_track_requests_created_at on track_requests (created_at desc);

-- 5. Режим «Для двоих» и «Энергия дня»
alter table track_requests add column if not exists mode text default 'single';
alter table track_requests drop constraint if exists track_requests_mode_check;
alter table track_requests add constraint track_requests_mode_check check (mode in ('single', 'couple', 'transit'));
alter table track_requests add column if not exists person2_name text;
alter table track_requests add column if not exists person2_birthdate text;
alter table track_requests add column if not exists person2_birthplace text;
alter table track_requests add column if not exists person2_birthtime text;
alter table track_requests add column if not exists person2_birthtime_unknown boolean default false;
alter table track_requests add column if not exists person2_gender text;
alter table track_requests add column if not exists transit_date text;
alter table track_requests add column if not exists transit_time text;
alter table track_requests add column if not exists transit_location text;
alter table track_requests add column if not exists transit_intent text;

-- 6. Аудит генерации: контроль каждого этапа (DeepSeek → парсинг → Suno)
alter table track_requests add column if not exists llm_truncated boolean default false;
alter table track_requests add column if not exists suno_style_sent text;
comment on column track_requests.deepseek_response is 'Полный сырой ответ DeepSeek (до парсинга)';
comment on column track_requests.llm_truncated is 'true если ответ обрезан по max_tokens (песня могла остаться недоделанной)';
comment on column track_requests.suno_style_sent is 'Точная строка style, отправленная в Suno (для сверки)';

-- 7. Обложка к генерации (URL от Suno Cover API, отправляется пользователю вместе с аудио)
alter table track_requests add column if not exists cover_url text;
comment on column track_requests.cover_url is 'URL обложки от Suno Cover API; отправляется в Telegram вместе с песней';

-- 7.1. Статус доставки (sent=доставлено, failed=не доставлено — проверка получения, не только отправки)
alter table track_requests add column if not exists delivery_status text;
comment on column track_requests.delivery_status is 'Статус доставки: sent=доставлено, failed=не доставлено';
create index if not exists idx_track_requests_delivery_status on track_requests (delivery_status);

-- =============================================================================
-- 8. Платежи HOT и тарифы (pricing, entitlements, subscriptions, user_trials)
-- ВАЖНО: без этих таблиц все запросы будут требовать оплату (ошибка 402)
-- =============================================================================

alter table if exists track_requests add column if not exists payment_provider text;
alter table if exists track_requests add column if not exists payment_status text;
alter table if exists track_requests add column if not exists payment_order_id text;
alter table if exists track_requests add column if not exists payment_tx_id text;
alter table if exists track_requests add column if not exists payment_amount numeric(12,2);
alter table if exists track_requests add column if not exists payment_currency text;
alter table if exists track_requests add column if not exists payment_raw jsonb;
alter table if exists track_requests add column if not exists paid_at timestamptz;
alter table if exists track_requests add column if not exists promo_code text;
alter table if exists track_requests add column if not exists promo_discount_amount numeric(12,2);
alter table if exists track_requests add column if not exists promo_type text;
alter table if exists track_requests add column if not exists generation_status text default 'pending';

create index if not exists idx_track_requests_payment_order_id on track_requests(payment_order_id);
create index if not exists idx_track_requests_payment_status on track_requests(payment_status);

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
alter table if exists pricing_catalog disable row level security;

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
alter table if exists user_entitlements disable row level security;
create index if not exists idx_user_entitlements_user on user_entitlements(telegram_user_id);
create index if not exists idx_user_entitlements_sku on user_entitlements(sku);

create table if not exists user_trials (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  trial_key text not null,
  consumed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(telegram_user_id, trial_key)
);
alter table if exists user_trials disable row level security;
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
alter table if exists subscriptions disable row level security;
create index if not exists idx_subscriptions_user on subscriptions(telegram_user_id);
create index if not exists idx_subscriptions_status on subscriptions(status);

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
alter table if exists promo_codes disable row level security;
create index if not exists idx_promo_codes_code on promo_codes(code);

create table if not exists promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references promo_codes(id) on delete cascade,
  telegram_user_id bigint not null,
  request_id uuid,
  order_id text,
  discount_amount numeric(12,2) default 0,
  created_at timestamptz not null default now()
);
alter table if exists promo_redemptions disable row level security;

insert into pricing_catalog (sku, title, description, price, currency, active, limits_json)
values
  ('single_song', 'Single song', 'Персональный звуковой ключ', 5.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('transit_energy_song', 'Transit energy song', 'Энергия дня (транзит)', 6.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('couple_song', 'Couple song', 'Песня совместимости пары', 8.99, 'USDT', true, '{"requests":1}'::jsonb),
  ('soul_basic_sub', 'Soul Basic', '3 трека/месяц + 10 soulchat', 14.99, 'USDT', true, '{"monthly_tracks":3,"monthly_soulchat":10,"kind":"subscription"}'::jsonb),
  ('soul_plus_sub', 'Soul Plus', '7 треков/месяц + 30 soulchat + приоритет', 24.99, 'USDT', true, '{"monthly_tracks":7,"monthly_soulchat":30,"priority":true,"kind":"subscription"}'::jsonb)
on conflict (sku) do update set price=excluded.price, active=excluded.active, updated_at=now();

insert into promo_codes (code, type, value, sku, max_uses, per_user_limit, active, metadata)
values
  ('WELCOMEGIFT', 'free_generation', null, null, null, 1, true, '{"title":"Один бесплатный трек по промокоду"}'::jsonb),
  ('SOUL10', 'discount_percent', 10, null, null, 5, true, '{"title":"Скидка 10%"}'::jsonb)
on conflict (code) do update set active=excluded.active, updated_at=now();

-- =============================================================================
-- 9. Soul Chat: доступ по времени + история сессий
-- =============================================================================

-- soul_chat_access: активный суточный доступ (триал или купленный)
create table if not exists soul_chat_access (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  expires_at timestamptz not null,
  source text not null default 'purchase',  -- 'gift_1day' | 'purchase_1day' | 'subscription'
  order_id text,
  created_at timestamptz not null default now()
);
alter table if exists soul_chat_access disable row level security;
create index if not exists idx_soul_chat_access_user on soul_chat_access(telegram_user_id);
create index if not exists idx_soul_chat_access_expires on soul_chat_access(expires_at);

-- soul_chat_sessions: история вопросов и ответов
create table if not exists soul_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  track_request_id uuid,
  question text not null,
  answer text,
  source text default 'gift_1day',  -- какой тип доступа использован
  created_at timestamptz not null default now()
);
alter table if exists soul_chat_sessions disable row level security;
create index if not exists idx_soul_chat_sessions_user on soul_chat_sessions(telegram_user_id);

-- SKU для покупки суточного доступа
insert into pricing_catalog (sku, title, description, price, currency, active, limits_json)
values ('soul_chat_1day', 'Soul Chat — 1 сутки', 'Безлимитный чат с душой на 24 часа', 2.99, 'USDT', true, '{"hours":24,"kind":"soul_chat_day"}'::jsonb)
on conflict (sku) do update set price=excluded.price, active=excluded.active, updated_at=now();

-- =============================================================================
-- 10. Профили пользователей (app_users) — нужна для /api/me (без неё 500 ошибка)
-- =============================================================================
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  tariff text not null default 'basic',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table if exists app_users disable row level security;
create index if not exists idx_app_users_telegram_user_id on app_users(telegram_user_id);

-- =============================================================================
-- 10. Soul Chat: суточный доступ и история диалогов
-- =============================================================================
create table if not exists soul_chat_access (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  source text not null default 'purchase', -- 'gift' | 'purchase' | 'subscription'
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table if exists soul_chat_access disable row level security;
create index if not exists idx_soul_chat_access_user_exp on soul_chat_access(telegram_user_id, expires_at);

create table if not exists soul_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  track_request_id uuid,
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);
alter table if exists soul_chat_sessions disable row level security;
create index if not exists idx_soul_chat_sessions_user on soul_chat_sessions(telegram_user_id);

-- SKU: суточный доступ к Soul Chat (2.99 USDT)
insert into pricing_catalog (sku, title, description, price, currency, active, limits_json)
values ('soul_chat_1day', 'Soul Chat 24ч', 'Неограниченное общение с душой 24 часа', 2.99, 'USDT', true, '{"kind":"soul_chat_day"}')
on conflict (sku) do update set price=excluded.price, title=excluded.title, active=excluded.active, updated_at=now();
-- =============================================================================
