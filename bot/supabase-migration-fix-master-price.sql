-- Исправление цены тарифа Лаборатория (master_monthly): было 299 RUB, должно быть 39.99 USDT.
-- Выполнить один раз в Supabase → SQL Editor если клиенты видели 299 (долларов или рублей).

UPDATE pricing_catalog
SET
  price    = 39.99,
  currency = 'USDT',
  title    = 'Лаборатория',
  description = '30 треков/месяц + Картотека + История генераций',
  limits_json = '{"monthly_tracks":30,"monthly_soulchat":-1,"priority":true,"lab_access":true,"kind":"subscription"}'::jsonb
WHERE sku = 'master_monthly';

-- Если колонка stars_price уже есть (миграция stars-price выполнена):
-- UPDATE pricing_catalog SET stars_price = 3070 WHERE sku = 'master_monthly';
