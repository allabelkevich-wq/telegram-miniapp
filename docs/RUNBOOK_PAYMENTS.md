# Runbook: платежи HOT (операционный)

## 1) Быстрые проверки при инциденте

1. Проверить доступность API:
   - `GET /healthz`
2. Проверить, что webhook доходит:
   - логи `POST /api/payments/hot/webhook`
3. Проверить заявку:
   - `GET /api/payments/hot/status?request_id=<uuid>`
4. Проверить запись в админке:
   - `/api/admin/payments`

## 2) Типовые сценарии и действия

### A. Пользователь оплатил, но статус pending

- Проверить, приходил ли webhook.
- Если webhook не пришёл:
  - сверить URL webhook в HOT.
- Если webhook пришёл, но подпись невалидна:
  - проверить `HOT_WEBHOOK_SECRET`.
- Временный обход:
  - вручную обновить `payment_status=paid` в `track_requests`,
  - вызвать `/api/payments/hot/confirm`.

### B. Дублирующийся webhook / повторы

- Нормальное поведение: обработчик идемпотентен по `payment_order_id`/`payment_tx_id`.
- Проверить, что дубли не создают повторную выдачу entitlement.

### C. Оплата есть, генерация не стартовала

- Вызвать `POST /api/payments/hot/confirm` с `request_id`.
- Если не стартует — перезапуск из админки:
  - `POST /api/admin/requests/:id/restart`.

### D. Промокод не применяется

- Проверить `active`, `starts_at`, `expires_at`, `max_uses`, `per_user_limit`, `sku`.
- Проверить ответ `POST /api/promos/validate`.

## 3) Ручная сверка в БД (минимум)

`track_requests`:

- `payment_provider`
- `payment_status`
- `payment_order_id`
- `payment_tx_id`
- `payment_amount`
- `payment_currency`
- `paid_at`

`promo_redemptions`:

- есть ли запись о списании промо для `telegram_user_id + request_id`.

`user_entitlements` / `subscriptions`:

- был ли выдан доступ после `paid`.

## 4) Метрики (рекомендуемые)

- Conversion free → paid
- Количество `payment_required` vs `paid`
- Webhook fail-rate (401/500)
- Среднее время до `paid`
- Доля ручных confirm/restart

