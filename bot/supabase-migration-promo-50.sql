-- Промокоды на 50% скидку на генерацию (на первое время).
-- Выполни в Supabase → SQL Editor.

INSERT INTO promo_codes (code, type, value, sku, max_uses, per_user_limit, active, metadata)
VALUES
  ('SOUL50', 'discount_percent', 50, null, null, 3, true, '{"title":"Скидка 50% на генерацию"}'::jsonb),
  ('YUP50', 'discount_percent', 50, null, null, 3, true, '{"title":"Скидка 50% на генерацию"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  type = EXCLUDED.type,
  value = EXCLUDED.value,
  per_user_limit = EXCLUDED.per_user_limit,
  active = EXCLUDED.active,
  metadata = EXCLUDED.metadata,
  updated_at = now();
