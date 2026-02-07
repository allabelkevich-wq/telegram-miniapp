-- Таблица заявок на звуковой ключ (MVP)
-- Выполни в Supabase SQL Editor при создании проекта.

create table if not exists track_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  name text,
  birthdate date,
  birthplace text,
  birthtime time,
  birthtime_unknown boolean default false,
  gender text,
  request text,
  status text default 'pending' check (status in ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_track_requests_telegram_user on track_requests(telegram_user_id);
create index if not exists idx_track_requests_status on track_requests(status);
create index if not exists idx_track_requests_created on track_requests(created_at desc);

comment on table track_requests is 'Заявки из Mini App на создание звукового ключа';

-- Бот пишет/читает по service_role; RLS для этой таблицы отключаем
alter table track_requests disable row level security;
