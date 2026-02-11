-- ДОПОЛНИТЕЛЬНЫЕ МИГРАЦИИ (только после проверки базовой: astro_snapshots + колонки в track_requests).
-- Выполни в Supabase → SQL Editor после того как базовая миграция применена и проверена.

-- 3. Статус генерации
alter table track_requests add column if not exists generation_status text default 'pending';
-- Ограничение: только допустимые значения (в PostgreSQL check можно добавить отдельно, если нужна строгость)
-- check (generation_status in ('pending', 'astro_calculated', 'lyrics_generated', 'suno_processing', 'completed', 'failed'))

-- 4. Полный ответ от DeepSeek (для отладки)
alter table track_requests add column if not exists deepseek_response text;

-- 5. Тип запроса
alter table track_requests add column if not exists request_type text default 'general';
-- check (request_type in ('general', 'relationships', 'career', 'health', 'spiritual', 'custom'))

-- 6. Индексы для производительности (без CONCURRENTLY — Supabase SQL Editor; при необходимости выполни индексы отдельно с CONCURRENTLY)
create index if not exists idx_track_requests_generation_status on track_requests (generation_status);
create index if not exists idx_track_requests_telegram_user on track_requests (telegram_user_id);
create index if not exists idx_track_requests_created_at on track_requests (created_at desc);
