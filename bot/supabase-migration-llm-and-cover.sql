-- Добавить недостающие колонки в track_requests (админка и воркер).
-- Выполни в Supabase: SQL Editor → New query → вставь этот блок → Run.

-- Статус генерации и аудит
alter table track_requests add column if not exists generation_status text default 'pending';
alter table track_requests add column if not exists deepseek_response text;
alter table track_requests add column if not exists detailed_analysis text;
alter table track_requests add column if not exists request_type text default 'general';
alter table track_requests add column if not exists llm_truncated boolean default false;
alter table track_requests add column if not exists suno_style_sent text;

-- Режимы и вторая персона (если ещё нет)
alter table track_requests add column if not exists mode text default 'single';
alter table track_requests add column if not exists person2_name text;
alter table track_requests add column if not exists person2_birthdate text;
alter table track_requests add column if not exists person2_birthplace text;
alter table track_requests add column if not exists person2_birthtime text;
alter table track_requests add column if not exists person2_birthtime_unknown boolean default false;
alter table track_requests add column if not exists person2_gender text;
alter table track_requests add column if not exists transit_date text;
alter table track_requests add column if not exists transit_time text;
alter table track_requests add column if not exists transit_location text;
alter table track_requests add column if not exists transit_intent text;

-- Обложка к генерации
alter table track_requests add column if not exists cover_url text;

-- Логи этапов для админки (цепочка): { "1": "Данные получены", "2": "DeepSeek ответил, 3421 симв.", ... }
alter table track_requests add column if not exists generation_steps jsonb default '{}';
