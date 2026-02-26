# HOT Payments Setup (YupSoul)

Краткая инструкция по включению платежей HOT в текущем бэкенде (`bot/index.js`).

## 1) Переменные окружения

Минимум:

- `BOT_TOKEN` — токен Telegram-бота.
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

Платежи HOT:

- `HOT_PAYMENT_URL` — базовый URL checkout (по умолчанию `https://pay.hot-labs.org/payment`).
- `HOT_WEBHOOK_SECRET` — секрет для подписи webhook.
- `HOT_API_JWT` — опционально, если нужен серверный вызов HOT API.
- `HOT_ITEM_ID_DEFAULT` — fallback item id.
- `HOT_ITEM_ID_<SKU>` — item id для конкретного SKU, например:
  - `HOT_ITEM_ID_SINGLE_SONG`
  - `HOT_ITEM_ID_COUPLE_SONG`
  - `HOT_ITEM_ID_TRANSIT_ENERGY_SONG`

Админ-доступ:

- `ADMIN_TELEGRAM_IDS` — CSV список Telegram user id админов.
- `ADMIN_SECRET` — токен для веб-админки (fallback, если нет initData админа).

## 2) Миграции БД

Выполнить SQL:

- `bot/supabase-migration-hot-monetization.sql`

Проверить, что созданы/добавлены:

- поля оплаты в `track_requests`;
- таблицы `pricing_catalog`, `user_entitlements`, `user_trials`, `subscriptions`;
- таблицы `promo_codes`, `promo_redemptions`.

## 3) Эндпоинты, которые должны быть доступны

- `GET /api/pricing/catalog`
- `POST /api/promos/validate`
- `POST /api/payments/hot/create`
- `POST /api/payments/hot/webhook`
- `GET /api/payments/hot/status`
- `POST /api/payments/hot/confirm`

Админ:

- `GET /api/admin/payments`
- `GET /api/admin/pricing`
- `PUT /api/admin/pricing/:sku`
- `GET /api/admin/promos`
- `PUT /api/admin/promos/:code`

## 4) Webhook HOT

URL webhook:

- `https://<your-bot-service>/api/payments/hot/webhook`

Требования:

- Рекомендуется: HOT отправляет подпись в `x-hot-signature` (или `x-signature`). Бэкенд проверяет HMAC SHA-256 через `HOT_WEBHOOK_SECRET`. Если заголовок подписи отсутствует — webhook принимается с предупреждением в логах (чтобы оплаты проходили; после настройки подписи в HOT проверка будет полной).

При «заказ не найден»: бэкенд делает повторный поиск через 1 с и 2 с (гонка с записью заказа). Если заказ так и не найден — в логах «Критично: заказ не найден после повторной проверки», опционально запись в таблицу `unmatched_payments` (memo, request_id, payload, received_at) для ручной проверки. Таблицу можно создать в Supabase при необходимости.

## 5) Smoke-check

1. Открыть Mini App в Telegram.
2. Отправить первую заявку:
   - ожидаем `gift_used` или `subscription_active`/`paid` (в зависимости от доступа).
3. При `payment_required`:
   - создать order через `/api/payments/hot/create`;
   - открыть checkout;
   - после оплаты дождаться `payment_status=paid` через `/api/payments/hot/status`.
4. Подтвердить запуск генерации (`/api/payments/hot/confirm`) если автозапуск не произошёл.
5. Убедиться, что в админке виден платеж и статус заявки.

