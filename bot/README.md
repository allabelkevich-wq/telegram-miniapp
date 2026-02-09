# YupSoul Bot

Telegram-бот для приёма заявок из Mini App и уведомлений пользователя.

## Что делает

- **`/start`** — приветствие и кнопка «Открыть приложение» (Mini App).
- **Данные из Mini App** — при нажатии в приложении «Оплатить» → «Отправить заявку во Вселенную» данные приходят боту. Бот сохраняет заявку и отвечает: «Заявка принята!».
- **`/get_analysis`** — запрос детальной расшифровки натальной карты (доступна после оплаты; фразы «расшифровка», «получить расшифровку» тоже срабатывают).
- **`/admin`** — только для админов: список последних заявок. Подробно: [НАСТРОЙКА_АДМИНА.md](./НАСТРОЙКА_АДМИНА.md).

**Пошаговая настройка с нуля:** [docs/ПОШАГОВАЯ_НАСТРОЙКА.md](../docs/ПОШАГОВАЯ_НАСТРОЙКА.md) — куда зайти, что скопировать, куда вставить.  
**Чеклист деплоя:** [docs/ЧЕКЛИСТ_ДЕПЛОЙ_И_ДАЛЬШЕ.md](../docs/ЧЕКЛИСТ_ДЕПЛОЙ_И_ДАЛЬШЕ.md).

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
2. Выполни скрипт из `bot/supabase-schema.sql` (таблицы `track_requests`, `astro_snapshots` и привязка).
3. В Settings → API скопируй **Project URL** и **service_role** key (не anon).
4. Добавь в `.env`:
   ```env
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...
   ```
После перезапуска бота заявки будут писаться в Supabase. Без этих переменных заявки только логируются в консоль.

## Астромодуль (Этап 2)

- **astroLib.js** — ведический/сидерический расчёт для анализа «МОЯ ДУША»: зодиак Lahiri, дома **Whole Sign**; накшатры/пады (божества, Дхарма/Артха/Кама/Мокша), аспекты (в т.ч. квинтиль, биквинтиль, минорные), Лилит, Хирон, Вертекс, Парс Фортуны, чара-караки, арудха-лагна. Функция `getAstroSnapshot(...)` возвращает текст и JSON для промптов.
- **geocode.js** — геокодинг места рождения (Nominatim): строка → `{ lat, lon }`.
- **workerAstro.js** — по заявке: геокодинг → расчёт снапшота → сохранение в `astro_snapshots` и привязка к `track_requests`. Вызов: `computeAndSaveAstroSnapshot(supabase, trackRequestId)`.
- **promptTemplates.js** — загрузка промптов из БД (`prompt_templates` по name и is_active), подстановка переменных `{{var}}`. Главный промпт: «Идеально отлаженный системный промт» (MAIN_PROMPT_NAME = `ideally_tuned_system_v1`). Функции: `loadPrompt(supabase, name)`, `substituteVariables(body, values)`, `getRenderedPrompt(supabase, name, variables)`.
- **greetingTemplates.js** — приветствия, которые отправляются пользователю **вместе с песней** (по типу запроса: отношения, финансы, здоровье, духовный, общий). Функция `getGreetingForSong(requestText, { name, title })` возвращает текст сообщения. Примеры из чата с Qwen3max можно подставить в `GREETINGS_BY_CATEGORY` в этом файле.

### Миграция prompt_templates (Этап 2)

Таблица шаблонов для DeepSeek/Suno и начальные промпты (archetype, lyrics, title, suno_config). Выполни в Supabase SQL Editor скрипт `bot/supabase-migration-prompt-templates.sql` (после `supabase-schema.sql`; при использовании «Мои герои» — после `supabase-migration-master-heroes.sql`). Главный промпт «Идеально отлаженный системный промт» загружается из файла `bot/prompts/ideally_tuned_system.txt` в таблицу командой: `npm run seed-ideally-tuned` (нужны SUPABASE_URL и SUPABASE_SERVICE_KEY в `.env`).

## Дальше

- **Воркер генерации**: `npm run worker:full` или `npm run worker:loop`. Читает заявки из `track_requests`, при необходимости считает астро, затем DeepSeek → Suno → отправка аудио в Telegram.
- **Расширение проекта**: куда добавлять новый LLM, другой генератор музыки, шаги пайплайна, промпты — см. [docs/RASSHIRENIE_PROEKTA.md](../docs/RASSHIRENIE_PROEKTA.md).
