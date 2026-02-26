-- Миграция для модуля «Мои герои — Master»
-- Запустить в Supabase → SQL Editor

-- Создаём таблицу клиентов/героев если её ещё нет
CREATE TABLE IF NOT EXISTS clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  name            text NOT NULL,
  birth_date      date,
  birth_time      time,
  birth_place     text,
  birthtime_unknown boolean DEFAULT false,
  gender          text,
  notes           text,
  preferred_style text,
  relationship    text,
  created_at      timestamptz DEFAULT now()
);

-- Если таблица уже существует — добавляем только новые колонки
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_style text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS relationship    text;

-- Индекс для быстрой выборки по пользователю
CREATE INDEX IF NOT EXISTS idx_clients_user_id ON clients (user_id);

-- Тариф master_monthly в pricing_catalog (Лаборатория — 39.99 USDT/мес, НЕ 299 RUB)
INSERT INTO pricing_catalog (sku, title, description, price, currency, active, limits_json)
VALUES (
  'master_monthly',
  'Лаборатория',
  '30 треков/месяц + Картотека + История генераций',
  39.99,
  'USDT',
  true,
  '{"monthly_tracks":30,"monthly_soulchat":-1,"priority":true,"lab_access":true,"kind":"subscription"}'::jsonb
)
ON CONFLICT (sku) DO UPDATE SET
  title        = EXCLUDED.title,
  description  = EXCLUDED.description,
  price        = EXCLUDED.price,
  currency     = EXCLUDED.currency,
  active       = EXCLUDED.active,
  limits_json  = EXCLUDED.limits_json;
