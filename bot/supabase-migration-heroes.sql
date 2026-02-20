-- Миграция для модуля «Мои герои — Master»
-- Запустить в Supabase → SQL Editor

-- Новые поля в таблице clients (герои)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_style text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS relationship text;

-- Тариф master_monthly в pricing_catalog
INSERT INTO pricing_catalog (sku, title, description, price, currency, active, limits_json)
VALUES (
  'master_monthly',
  'Мои герои — Master',
  'Личный кабинет героев: неограниченные герои, история генераций, стили музыки',
  299,
  'RUB',
  true,
  '{"type":"master_access","period_days":30}'
)
ON CONFLICT (sku) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  price = EXCLUDED.price,
  currency = EXCLUDED.currency,
  active = EXCLUDED.active,
  limits_json = EXCLUDED.limits_json;
