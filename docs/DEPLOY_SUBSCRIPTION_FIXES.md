# Инструкция по деплою исправлений активации подписок

## Быстрый старт

### 1. Применить SQL миграцию в Supabase

1. Открыть [Supabase SQL Editor](https://supabase.com/dashboard)
2. Выбрать проект YupSoul
3. Скопировать содержимое файла `bot/supabase-migration-subscription-fixes.sql`
4. Вставить в SQL Editor и нажать Run

**Что создаст миграция:**
- Таблица `unmatched_payments` - для необработанных платежей
- Таблица `subscription_activation_errors` - для логирования ошибок активации
- Новые индексы для оптимизации запросов
- Новые поля в `track_requests`: `subscription_activation_attempts`, `subscription_activated_at`

### 2. Задеплоить код на Render

```bash
# Убедиться что локальный main актуален
git pull origin main

# Добавить файлы
git add bot/index.js
git add bot/supabase-migration-subscription-fixes.sql
git add docs/SUBSCRIPTION_ACTIVATION_FIXES.md
git add docs/DEPLOY_SUBSCRIPTION_FIXES.md

# Закоммитить
git commit -m "fix: улучшена обработка активации подписок

- Добавлено 3-5 retry попыток для webhook и Stars
- Проверка фактической активации после каждой попытки
- Логирование всех ошибок в subscription_activation_errors
- Расширен период восстановления с 7 до 90 дней
- Улучшены API endpoints: claim, confirm, subscription/status
- Новые поля в track_requests для отслеживания активации"

# Отправить в main
git push origin main
```

Render автоматически задеплоит изменения в течение 2-3 минут.

### 3. Проверить деплой

1. Открыть [Render Dashboard](https://dashboard.render.com/)
2. Найти сервис YupSoul Bot
3. Проверить что Deploy успешен (статус "Live")
4. Проверить логи на наличие ошибок

### 4. Проверить существующие проблемные подписки

В Supabase SQL Editor выполнить:

```sql
-- Найти оплаченные подписки без активации
SELECT 
  id,
  telegram_user_id,
  mode,
  payment_status,
  payment_order_id,
  created_at,
  subscription_activated_at
FROM track_requests
WHERE mode LIKE 'sub_%' 
  AND payment_status = 'paid'
  AND subscription_activated_at IS NULL
  AND created_at > NOW() - INTERVAL '90 days'
ORDER BY created_at DESC;
```

Если найдены записи — обновленный код автоматически активирует подписки при следующем обращении пользователя к API (через `ensureSubscriptionFromPaidRequests`).

### 5. Мониторинг после деплоя

В логах Render искать:
- `[sub]` - операции с подписками
- `[sub/error]` - критические ошибки (должны записываться в БД)
- `[webhook]` - обработка HOT Pay вебхуков
- `[Stars]` - платежи через Telegram Stars
- `[sub/repair]` - автоматическое восстановление

**Нормальные логи после исправлений:**
```
[sub] Подписка soul_plus_sub создана и проверена для 123456789, renew_at: 2026-03-29...
[webhook] grantPurchaseBySku ok (attempt 1/5): sku=soul_plus_sub, userId=123456789
[webhook] Подписка soul_plus_sub проверена и активна для 123456789
```

**Если видите ошибки:**
```
[sub/error] Залогирована ошибка активации: user=123456789, sku=soul_plus_sub...
```

Проверить таблицу:
```sql
SELECT * FROM subscription_activation_errors 
WHERE resolved_at IS NULL 
ORDER BY created_at DESC 
LIMIT 10;
```

## Что делать если нашлись необработанные подписки

### Автоматическое восстановление

Обновленный код автоматически активирует подписку при следующем запросе пользователя:
- При открытии профиля (вызывается `/api/subscription/status`)
- При создании новой заявки (вызывается `ensureSubscriptionFromPaidRequests`)

**Ничего делать не нужно** — система сама восстановит подписку.

### Ручная активация (если очень срочно)

Если нужно активировать прямо сейчас, использовать админку:

1. Открыть админку: `https://yupsoul-bot.onrender.com/admin?token=ADMIN_SECRET`
2. Найти пользователя по ID
3. Нажать "Выдать подписку"
4. Выбрать нужный план

Или через SQL:

```sql
-- Активировать подписку вручную
INSERT INTO subscriptions (
  telegram_user_id,
  plan_sku,
  status,
  renew_at,
  source,
  created_at,
  updated_at
)
SELECT 
  telegram_user_id,
  CASE 
    WHEN mode = 'sub_soul_basic_sub' THEN 'soul_basic_sub'
    WHEN mode = 'sub_soul_plus_sub' THEN 'soul_plus_sub'
    WHEN mode = 'sub_master_monthly' THEN 'master_monthly'
  END as plan_sku,
  'active' as status,
  NOW() + INTERVAL '30 days' as renew_at,
  'manual_fix' as source,
  NOW() as created_at,
  NOW() as updated_at
FROM track_requests
WHERE id = 'UUID-ЗАЯВКИ'  -- заменить на реальный UUID
ON CONFLICT DO NOTHING;

-- Обновить заявку
UPDATE track_requests
SET subscription_activated_at = NOW()
WHERE id = 'UUID-ЗАЯВКИ';  -- заменить на реальный UUID
```

## Откат (если что-то пошло не так)

### Откатить код

```bash
# Найти предыдущий коммит
git log --oneline -5

# Откатиться
git revert HEAD
git push origin main
```

### Откатить миграцию

**НЕ РЕКОМЕНДУЕТСЯ** — новые таблицы не влияют на работу системы. Но если очень нужно:

```sql
-- Откат миграции (только если критично)
DROP TABLE IF EXISTS subscription_activation_errors CASCADE;
DROP TABLE IF EXISTS unmatched_payments CASCADE;

ALTER TABLE track_requests DROP COLUMN IF EXISTS subscription_activation_attempts;
ALTER TABLE track_requests DROP COLUMN IF EXISTS subscription_activated_at;
```

## FAQ

**Q: Нужно ли обновлять фронтенд?**  
A: Нет, все изменения только в бэкенде. Фронтенд уже вызывает все нужные API.

**Q: Затронет ли это существующие активные подписки?**  
A: Нет, активные подписки останутся без изменений. Код только улучшает обработку новых платежей.

**Q: Что делать если пользователь пишет что подписка не активировалась?**  
A: 
1. Проверить в Supabase что заявка помечена `payment_status = 'paid'`
2. Проверить таблицу `subscription_activation_errors` на наличие ошибок для этого пользователя
3. Попросить пользователя открыть профиль в приложении — подписка активируется автоматически
4. Если не помогло — активировать вручную через админку

**Q: Как часто нужно проверять subscription_activation_errors?**  
A: Рекомендуется раз в день первую неделю после деплоя, затем раз в неделю.

## Контакты поддержки

При проблемах:
1. Проверить логи Render
2. Проверить таблицу `subscription_activation_errors` в Supabase
3. Если нужна помощь — написать в поддержку с примером из логов
