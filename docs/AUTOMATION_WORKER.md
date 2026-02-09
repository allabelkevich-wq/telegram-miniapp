# Воркер полной автоматизации заявок

Воркер забирает заявки со статусом `pending` и с уже посчитанным натальным снапшотом, генерирует текст (DeepSeek) и музыку (Suno), затем отправляет аудио пользователю в Telegram и ставит статус `completed`.

## Что нужно перед запуском

1. **Переменные в `.env`**
   - `BOT_TOKEN` — уже есть для бота
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — уже есть
   - `DEEPSEEK_API_KEY` — ключ с [platform.deepseek.com](https://platform.deepseek.com/api_keys)
   - `SUNO_API_KEY` — ключ с [sunoapi.org](https://sunoapi.org/api-key)

2. **Миграция БД**  
   В Supabase → SQL Editor выполни добавление колонок (если ещё не делала):

   ```sql
   alter table track_requests add column if not exists lyrics text;
   alter table track_requests add column if not exists title text;
   alter table track_requests add column if not exists audio_url text;
   alter table track_requests add column if not exists suno_task_id text;
   alter table track_requests add column if not exists error_message text;
   ```

3. **Промпт в БД**  
   Воркер использует шаблон `ideally_tuned_system_v1` из таблицы `prompt_templates`. Если его ещё нет — выполни один раз:

   ```bash
   npm run seed-ideally-tuned
   ```

## Как запускать

- **Один проход (одна заявка):**
  ```bash
  cd bot && npm run worker
  ```
  Удобно вызывать по крону, например раз в 5–10 минут:
  ```cron
  */10 * * * * cd /path/to/telegram-miniapp/bot && node workerGenerate.js
  ```

- Воркер берёт **одну** заявку за раз (статус `pending` и заполнен `astro_snapshot_id`), ставит её в `processing`, генерирует текст и музыку, отправляет аудио в чат пользователю и переводит в `completed`. При ошибке ставит `failed` и пишет в `error_message`.

## Цепочка

1. Заявка создаётся в боте (Mini App → «Отправить заявку»).
2. Бот сохраняет её в `track_requests` и в фоне вызывает `computeAndSaveAstroSnapshot` — появляется запись в `astro_snapshots` и у заявки заполняется `astro_snapshot_id`.
3. Воркер находит заявку `pending` с `astro_snapshot_id`, подставляет данные в промпт из `prompt_templates`, вызывает DeepSeek.
4. Из ответа DeepSeek извлекаются название песни, лирика и стиль; лирика отправляется в Suno.
5. Воркер ждёт готовности трека (поллинг Suno API), получает URL аудио.
6. Через Telegram Bot API отправляет пользователю `sendAudio` с этим URL и ставит заявке `completed`.

## Файлы

- `bot/workerGenerate.js` — точка входа воркера
- `bot/deepseek.js` — вызов DeepSeek API (chat completions)
- `bot/suno.js` — запуск генерации и поллинг результата Suno
- Промпт и подстановка переменных: `promptTemplates.js`, таблица `prompt_templates`

## Ошибки

- Если заявка ушла в `failed`, смотри поле `error_message` в БД или логи воркера.
- Типичные причины: нет ключей API, нет промпта в БД, лимиты/ошибки Suno или DeepSeek, блокировка контента Suno (чувствительные слова).
