# Rollback для `supabase-migration-hot-monetization.sql`

> Внимание: rollback удаляет данные монетизации и промокодов.  
> Выполнять только при необходимости отката схемы.

```sql
-- 1) Таблицы монетизации
drop table if exists promo_redemptions;
drop table if exists promo_codes;
drop table if exists subscriptions;
drop table if exists user_trials;
drop table if exists user_entitlements;
drop table if exists pricing_catalog;

-- 2) Индексы (если остались)
drop index if exists idx_track_requests_payment_order_id;
drop index if exists idx_track_requests_payment_status;
drop index if exists idx_track_requests_payment_provider;

-- 3) Колонки в track_requests
alter table if exists track_requests drop column if exists promo_type;
alter table if exists track_requests drop column if exists promo_discount_amount;
alter table if exists track_requests drop column if exists promo_code;

alter table if exists track_requests drop column if exists paid_at;
alter table if exists track_requests drop column if exists payment_raw;
alter table if exists track_requests drop column if exists payment_currency;
alter table if exists track_requests drop column if exists payment_amount;
alter table if exists track_requests drop column if exists payment_tx_id;
alter table if exists track_requests drop column if exists payment_order_id;
alter table if exists track_requests drop column if exists payment_status;
alter table if exists track_requests drop column if exists payment_provider;
```

## После rollback

1. Перезапустить сервис.
2. Проверить, что старый поток без HOT работает корректно.
3. Отключить кнопки/экраны оплаты на фронте (если нужно).

