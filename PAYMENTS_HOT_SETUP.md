# PAYMENTS_HOT_SETUP — настройка платежей HOT

## Обзор

Интеграция YupSoul с платёжным провайдером HOT для приёма оплат в USDT/TON через Telegram Mini App.

## Переменные окружения

| Переменная | Описание | Обязательно |
|------------|----------|-------------|
| `HOT_WEBHOOK_SECRET` | Секрет для проверки подписи webhook от HOT | Да, для production |
| `HOT_PAYMENT_URL` | Базовый URL checkout (по умолчанию: `https://pay.hot-labs.org/payment`) | Нет |
| `HOT_API_JWT` | JWT для API HOT (если требуется) | Нет |
| `HOT_ITEM_ID_DEFAULT` | Дефолтный item_id для checkout | Нет |
| `HOT_ITEM_ID_SINGLE_SONG` | item_id для single_song | Нет |
| `HOT_ITEM_ID_COUPLE_SONG` | item_id для couple_song | Нет |
| `HOT_ITEM_ID_TRANSIT_ENERGY_SONG` | item_id для transit_energy_song | Нет |
| `HOT_REDIRECT_URL` | URL для редиректа после оплаты (по умолчанию: тот же что `MINI_APP_URL` без query) | Нет |

## «Redirect URL domain does not match the configured redirect domain»

Эта ошибка на странице оплаты — домен редиректа не добавлен в настройки HOT.

**Что сделать:** в панели HOT Pay ([pay.hot-labs.org](https://pay.hot-labs.org)) → твоя платёжная ссылка (item) → **Redirect Domain** — добавь:

```
telegram-miniapp-ar09.onrender.com
```

Только домен, без `https://` и пути. Сохрани изменения.

## Webhook

1. **URL webhook:** `POST /api/payments/hot/webhook`
   - Полный URL: `https://<BOT_DOMAIN>/api/payments/hot/webhook`

2. **Регистрация:** Зарегистрировать этот URL в личном кабинете HOT.

3. **Проверка подписи:** Бот проверяет заголовок подписи (обычно `X-HOT-Signature` или аналог) с помощью `HOT_WEBHOOK_SECRET`.

## Порядок включения

1. Выполнить миграцию БД: `bot/supabase-migration-hot-monetization.sql`
2. Задать `HOT_WEBHOOK_SECRET` в Render (или другом хостинге)
3. Зарегистрировать webhook URL в HOT
4. Опционально задать `HOT_ITEM_ID_*` для каждого SKU
5. Перезапустить бота

## Чеклист готовности

- [ ] Миграция БД выполнена (`bot/supabase-migration-hot-monetization.sql`)
- [ ] `HOT_WEBHOOK_SECRET` задан в env
- [ ] Webhook URL зарегистрирован в HOT: `https://<BOT_DOMAIN>/api/payments/hot/webhook`
- [ ] Опционально: `HOT_ITEM_ID_*` для SKU в env (см. `bot/.env.example`)
- [ ] Бот перезапущен после изменений env

## Проверка

- Открыть Mini App → Форма → Оплата
- При отсутствии free trial: нажать «Оплатить с HOT» → должен открыться checkout
- После оплаты: webhook должен прийти, статус обновиться, генерация запуститься

---

## Официальная документация HOT (выжимка)

Источники: [pay.hot-labs.org](https://pay.hot-labs.org), GitBook HOT Pay (Quickstart, Developer API, Use with Lovable).

### Создание платёжной ссылки (admin)

В [pay.hot-labs.org](https://pay.hot-labs.org) → New link:

| Поле | Обязательно | Описание |
|------|--------------|----------|
| Link Name | Да | Название, отображается на checkout |
| Description | Нет | Краткое описание |
| Icon URL | Нет | PNG/JPG/SVG, квадрат 1:1 |
| Product Price | Нет | Фиксированная сумма; если пусто — передавать `amount` в URL или пользователь вводит сам |
| **Payment Token** | **Да** | Токен приёма (напр. USDC). «Не можете найти токен» на checkout часто из-за настроек ссылки (выбранный токен/сеть). |
| Redirect Domain | Нет | Домен редиректа после оплаты (только домен). Либо полный URL через `redirect_url` в запросе. |
| Webhook URL | Нет | HTTPS endpoint для уведомлений о платеже (рекомендуется задать в ссылке). |

### Параметры URL checkout

Рекомендуемый формат (из доки):

`https://pay.hot-labs.org/payment?item_id=<ITEM_ID>&amount=12&memo=ORDER_ID&redirect_url=https://example.com/success`

- **item_id** — ID платёжной ссылки из админки.
- **amount** — сумма (если не задана в Product Price).
- **memo** — идентификатор заказа; **приходит в webhook** — по нему связываем платёж с заявкой. Обязательно передавать.
- **redirect_url** — полный URL редиректа после успешной оплаты.

В нашем боте: в URL добавляются `memo` (orderId) и `redirect_url` (из `HOT_REDIRECT_URL` или базовый URL мини-аппа).

### Webhook

- Вызывается после подтверждения платежа (даже если пользователь не вернулся по redirect).
- Формат примера: `type`, `item_id`, `status` (напр. `SUCCESS`), **memo**, `amount`, `amount_float`, `amount_usd`, **near_trx** (хэш транзакции).
- Проверка транзакций: [hotscan.org](https://hotscan.org), [nearblocks.io](https://nearblocks.io).
- Тест доставки: `POST https://api.hot-labs.org/partners/merchant_item/{ITEM_ID}/test_webhook` (с JWT).

Наш webhook принимает **memo** как идентификатор заказа (и при необходимости `order_id`) и **near_trx** как хэш транзакции.

### Developer API

- JWT получается в разделе для разработчиков в админке.
- Get Processed Payments: `GET https://api.hot-labs.org/partners/processed_payments` с заголовком `Authorization: Bearer <JWT>`, query: `item_id`, `memo`, `sender_id`, `limit`, `offset`.

### Backend-confirmed flow (Lovable / общий подход)

1. Создать заказ в бэкенде, сгенерировать уникальный **memo** (например UUID).
2. Редирект пользователя на HOT с `item_id`, `amount`, `memo`, при необходимости `redirect_url` и `webhook_url`.
3. HOT обрабатывает платёж on-chain.
4. HOT шлёт webhook с `status === "SUCCESS"` и `memo`.
5. Только по webhook: найти заказ по `memo`, отметить как оплаченный, выдать продукт. Редирект с фронта не считать подтверждением оплаты.

### Термины и инфраструктура

- HOT Pay — не кастодиальный сервис; платёж идёт on-chain между пользователем и мерчантом (NEAR OmniBridge, NEAR Intents).
- Токен приёма и домен редиректа задаются **в настройках платёжной ссылки** в админке HOT; при проблемах «не видит кошелёк» / «не тот токен» в первую очередь проверить настройки ссылки (Payment Token, при необходимости Redirect Domain).

---

## Что уточнить у HOT (документация / поддержка)

Если на странице checkout HOT пользователь видит «Не можете найти нужный токен? Подключить другой кошелёк» / «Нет кошелька?», а кнопки не реагируют или кошелёк не подключается — проблема на стороне интерфейса HOT. Ниже список того, что **имеет смысл запросить у HOT** (документация или ответ поддержки).

### 1. Открытие checkout из Telegram Mini App

- Поддерживается ли открытие checkout **внутри WebView Mini App** (Telegram in-app browser), или только во внешнем браузере?
- Нужно ли передавать в URL checkout что-то из Telegram (например `tgWebAppData`, `initData`) для корректной работы кошелька/кнопок?
- Рекомендуемый способ открытия: `window.open`, `Telegram.WebApp.openLink`, или их iframe/embed?

### 2. Подключение кошелька и выбор токена

- Какие кошельки и сети официально поддерживаются (TON, TON Space, и т.д.)?
- Какой токен и в какой сети ожидается по умолчанию (например USDT в TON)?
- Есть ли параметры URL (например `currency`, `network`, `token`), которые мы должны передавать, чтобы страница сразу показывала нужный токен и не показывала «не можете найти токен»?

### 3. Кнопки «Подключить другой кошелёк» / «Нет кошелька?»

- Есть ли известные ограничения в WebView Telegram (или в iframe), из-за которых эти кнопки могут не срабатывать?
- Нужна ли предварительная регистрация нашего Mini App URL / домена в личном кабинете HOT для корректной работы checkout?

### 4. Тест vs прод

- Отдельная ли документация/URL для тестовых платежей?
- Нужны ли тестовые кошельки/сети, чтобы воспроизвести оплату без реальных средств?

### Куда писать

- Официальный сайт/документация HOT: проверить разделы про **Merchant API**, **Checkout**, **Telegram Mini App**.
- Поддержка HOT: запрос с описанием (открытие из Mini App → экран выбора кошелька/токена → кнопки не работают) и скриншотами; приложить наш checkout URL (без секретов) и способ открытия (`openLink`).
