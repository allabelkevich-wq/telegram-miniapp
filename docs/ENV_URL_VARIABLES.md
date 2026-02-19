# Переменные окружения с URL — разбор и упрощение

## Текущая ситуация (почему запутанно)

Один и тот же адрес `https://telegram-miniapp-ar09.onrender.com` используется в 5–6 переменных с небольшими отличиями. Это **избыточно** и **запутывает**.

### Кто как используется в коде

| Переменная | Используется в коде? | Назначение |
|------------|----------------------|------------|
| **RENDER_EXTERNAL_URL** | Да | Главный источник. Render задаёт автоматически. Без неё бот не стартует. |
| **MINI_APP_URL** | Частично | Только fallback, когда нет RENDER_EXTERNAL_URL. На Render фактически **игнорируется** — берётся RENDER_EXTERNAL_URL. |
| **WEBHOOK_URL** | Да | Базовый URL для Telegram webhook: `WEBHOOK_URL/webhook` |
| **BOT_PUBLIC_URL** | Да | Ссылка на админку в команде /admin |
| **HEROES_API_BASE** | Да | Fallback для BOT_PUBLIC_URL. В `index.html` URL **захардкожен** — не из env. |
| **WEB_APP_URL** | **Нет** | Нигде не используется, можно удалить. |

## Рекомендуемая упрощённая конфигурация

### Обязательно оставить

1. **RENDER_EXTERNAL_URL** — Render задаёт сам. Значение: `https://telegram-miniapp-ar09.onrender.com`
2. **WEBHOOK_URL** — для вебхуков Telegram. Значение: `https://telegram-miniapp-ar09.onrender.com` (без `/app`)

### Можно удалить (дублируют один и тот же URL)

- **MINI_APP_URL** — на Render не влияет, приоритет у RENDER_EXTERNAL_URL
- **WEB_APP_URL** — не используется в коде
- **BOT_PUBLIC_URL** — код возьмёт WEBHOOK_URL или HEROES_API_BASE
- **HEROES_API_BASE** — используется только как fallback для BOT_PUBLIC_URL

### Итоговая мини-конфигурация

```
RENDER_EXTERNAL_URL = https://telegram-miniapp-ar09.onrender.com   (часто уже есть от Render)
WEBHOOK_URL         = https://telegram-miniapp-ar09.onrender.com   (если нужны вебхуки)
```

Остальные URL-переменные не обязательны — код подставит значения через цепочку fallback.

## Важно: `/app` или без?

- **WEBHOOK_URL** — только база, **без** `/app`. Telegram шлёт запросы на `.../webhook`.
- **MINI_APP_URL** (внутренняя) — формируется как `RENDER_EXTERNAL_URL + "?v=19"`. Приложение отдаётся и по `/`, и по `/app` — оба пути рабочие.
- Если в BotFather кнопка меню настроена на `.../app` — это ок. Если на `.../` — тоже ок.

## Ошибки это не вызовет

Одинаковые или очень похожие URL в нескольких переменных **не приводят к сбоям**. Проблемы могут быть только если:
- указан неверный домен (другой сервис);
- в WEBHOOK_URL есть `/app` (должен быть базовый URL);
- RENDER_EXTERNAL_URL пустой или указывает на Vercel.
