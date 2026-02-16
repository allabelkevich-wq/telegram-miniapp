# Аудит проекта по ТЗ и запросам

**Дата:** 2026-02-16

## Соответствие ТЗ (финальная версия с автовходом)

| Требование | Статус | Где |
|------------|--------|-----|
| Профили по Telegram ID | ✅ | `user_profiles` таблица, API `/api/user/profile`, upsert в submit-request |
| Автовход в Mini App | ✅ | fetchUserProfile, homeGreeting, fillFormFromProfile при «Начать» |
| Расширенные калькуляторы в промт | ✅ | workerSoundKey: D4/D7/D9/D10/D30, даши, транзиты в userRequest |
| Правила D-9/D-10 в системном промпте | ✅ | ideally-tuned-system-prompt.txt |
| Soul Chat без request_id | ✅ | getLastCompletedRequestForUser, /soulchat без аргумента |
| Кнопка «Поговорить с душой» | ✅ | successPage, soulChatBtn → t.me/Yup_Soul_bot |
| Контраст «твоя жизнь — игра» | ✅ | --subtitle-readable |
| Оплата: читаемые блоки, единая палитра | ✅ | pricingNotice, priceSummary, setPaymentStatus — золото, белый текст |
| Отладочные элементы скрыты | ✅ | payment-build-badge display:none, DBG HOT только при !tg |
| Автодеплой в правилах | ✅ | .cursorrules |

## Несоответствия и ошибки (исправлены или к исправлению)

### 1. Терминология в боте (PROJECT_BRIEF: «натальная карта» не в интерфейсе) — **ИСПРАВЛЕНО**
- **Проблема:** В сообщениях пользователю в bot/index.js встречалось «расшифровка натальной карты», «натальная карта».
- **Решение:** Заменено на «расшифровка узора» / «разбор» в сообщениях по /get_analysis и меню.

### 2. Сброс формы «Создать ещё один ключ» — **ИСПРАВЛЕНО**
- **Проблема:** newKeyBtn не сбрасывал data-place-selected, data-lat, data-lon у поля birthplace.
- **Решение:** В обработчике newKeyBtn добавлена очистка атрибутов у birthplace и скрытие placeCoords.

### 3. Структура index.html
- **Факт:** В корне репозитория нет index.html, только public/index.html. Workflow деплоя использует `path: public`.
- **Рекомендация:** Обновить .cursorrules: «основной файл — public/index.html» либо восстановить корневой index.html как источник и синхронизацию в public.

## Внутренние/служебные упоминания (оставлены как есть)
- Промпты для ИИ (ideally-tuned, workerSoundKey): «натальная карта» в инструкциях для модели — ок.
- Комментарии в коде, миграции SQL, логи — ок.
- Сообщения админу (например, «НАТАЛЬНАЯ КАРТА для заявки») — внутренние, можно оставить или заменить по желанию.
