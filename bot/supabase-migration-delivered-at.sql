-- Момент фактической доставки песни пользователю в чат (для точных статусов в админке).
-- Выполни в Supabase → SQL Editor при необходимости.

alter table track_requests add column if not exists delivered_at timestamptz;
comment on column track_requests.delivered_at is 'Когда песня фактически отправлена пользователю в чат (аудио или fallback-сообщение)';
