# YupSoul Bot

Telegram-бот для приёма заявок из Mini App и уведомлений пользователя.

## Что делает

- **`/start`** — приветствие и кнопка «Открыть приложение» (Mini App).
- **Данные из Mini App** — при нажатии в приложении «Оплатить» → «Отправить заявку во Вселенную» данные приходят боту. Бот сохраняет заявку и отвечает: «Заявка принята!».
- **`/admin`** — только для админов: список последних заявок. Подробно: [НАСТРОЙКА_АДМИНА.md](./НАСТРОЙКА_АДМИНА.md).

## Запуск

1. Создай бота в [@BotFather](https://t.me/BotFather), скопируй токен.
2. В папке `bot/` создай файл `.env`:
   ```env
   BOT_TOKEN=твой_токен_от_BotFather
   MINI_APP_URL=https://allabelkevich-wq.github.io/telegram-miniapp/
   ADMIN_TELEGRAM_IDS=твой_telegram_id
   ```
   **Как узнать свой Telegram ID:** напиши в Telegram боту [@userinfobot](https://t.me/userinfobot) — он пришлёт твой ID (число). Вставь его в `ADMIN_TELEGRAM_IDS`. Несколько админов через запятую: `123456,789012`.
   (Можно скопировать из `.env.example`.)
3. Установи зависимости и запусти:
   ```bash
   cd bot
   npm install
   npm start
   ```
4. В [@BotFather](https://t.me/BotFather) → твой бот → Bot Settings → Menu Button → укажи URL Mini App (тот же `MINI_APP_URL`), чтобы под полем ввода была кнопка «Открыть приложение».

## Проверка связки

1. Открой бота в Telegram, нажми кнопку меню (или `/start` и кнопку) — откроется Mini App.
2. Заполни форму, перейди на «Оплата», нажми «Оплатить».
3. Внизу появится кнопка «Отправить заявку во Вселенную». Нажми её — приложение закроется, в чате придёт ответ бота «Заявка принята!».
4. В консоли, где запущен бот, появится лог заявки.

## Supabase (опционально)

Чтобы сохранять заявки в БД:

1. Создай проект в [Supabase](https://supabase.com), открой SQL Editor.
2. Выполни скрипт из `bot/supabase-schema.sql` (создаётся таблица `track_requests`).
3. В Settings → API скопируй **Project URL** и **service_role** key (не anon).
4. Добавь в `.env`:
   ```env
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...
   ```
После перезапуска бота заявки будут писаться в Supabase. Без этих переменных заявки только логируются в консоль.

## Дальше

- **Воркер генерации**: читать заявки из очереди (track_requests/track_jobs), вызывать DeepSeek/Suno, отправлять пользователю аудио через `ctx.replyWithAudio()`.
