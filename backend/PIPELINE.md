# Генерация песен: один контур (bot/)

Полный пайплайн (астро → DeepSeek → Suno → отправка в Telegram) реализован в **bot/**:

- **bot/index.js** — приём заявок из Mini App (sendData или POST /submit-request), сохранение в Supabase `track_requests`.
- **bot/runFullPipeline.js** → **workerGenerate.js** (runOnceWithAstro) — одна заявка: при необходимости расчёт натальной карты (workerAstro), затем DeepSeek (текст), Suno (аудио), отправка пользователю через бота.
- **bot/worker-loop.js** — цикл запуска воркера (по крону или вручную).

**backend/** (этот каталог) — устарел, не используется. API встроен в `bot/index.js` на Render. Для реальных песен заявки идут в бота (Mini App → sendData или HEROES_API_BASE на `telegram-miniapp-ar09.onrender.com`), воркер обрабатывает их на Render.

См. **docs/ЗАПУСК_ПОЛНОГО_ПАЙПЛАЙНА.md**, **bot/README.md**.
