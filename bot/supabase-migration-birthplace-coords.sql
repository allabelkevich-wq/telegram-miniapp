-- Координаты места рождения из Mini App (выбор из подсказок карты).
-- Выполни в Supabase → SQL Editor → New query → Run.

alter table track_requests add column if not exists birthplace_lat double precision;
alter table track_requests add column if not exists birthplace_lon double precision;
comment on column track_requests.birthplace_lat is 'Широта места рождения (из Mini App, выбор из подсказок)';
comment on column track_requests.birthplace_lon is 'Долгота места рождения (из Mini App)';
