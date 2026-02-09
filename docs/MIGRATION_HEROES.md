# Миграция «Мои герои»

## Вариант 1: Через скрипт (если есть доступ к БД по URI)

1. В Supabase: **Project Settings → Database** → скопируй **Connection string → URI**.
2. Замени в строке `[YOUR-PASSWORD]` на пароль от базы (тот, что задавал при создании проекта).
3. В папке `bot/` создай или отредактируй `.env` и добавь (подставь вместо `ТВОЙ_ПАРОЛЬ` пароль от БД из Supabase → Settings → Database):
   ```env
   DATABASE_URL=postgresql://postgres:ТВОЙ_ПАРОЛЬ@db.fcnyhsmhvmliojonswcv.supabase.co:5432/postgres
   ```
   Проект Supabase: `https://fcnyhsmhvmliojonswcv.supabase.co`
4. Выполни:
   ```bash
   cd bot
   npm run run-migration
   ```
   Должно вывести: «Миграция выполнена успешно».

## Вариант 2: Вручную в Supabase SQL Editor

1. Открой [Supabase Dashboard](https://supabase.com/dashboard) → свой проект.
2. Слева выбери **SQL Editor** → **New query**.
3. Открой файл **`bot/supabase-migration-master-heroes.sql`** и скопируй весь его текст.
4. Вставь в редактор и нажми **Run** (или Ctrl+Enter).
5. Внизу должно быть сообщение об успешном выполнении.

## Проверка

После миграции в **Table Editor** должны появиться:

- **app_users** — колонки: id, telegram_user_id, tariff, created_at, updated_at
- **clients** — колонки: id, user_id, name, birth_date, birth_time, birth_place, birthtime_unknown, gender, notes, created_at, updated_at
- В таблице **track_requests** — новая колонка **client_id**

Если что-то пошло не так, пришли текст ошибки из SQL Editor или из вывода `npm run run-migration`.
