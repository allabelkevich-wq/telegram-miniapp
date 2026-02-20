-- Счётчик попыток перегенерации при ошибке (автоповтор в воркере).
-- Выполни в Supabase → SQL Editor при необходимости.

alter table track_requests add column if not exists generation_retry_count integer not null default 0;
comment on column track_requests.generation_retry_count is 'Количество уже выполненных попыток перегенерации при ошибке (автоповтор до лимита)';
