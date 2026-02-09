-- Миграция: тариф "Мастер" и модуль "Мои герои" (клиенты)
-- Выполнить в Supabase SQL Editor после основного supabase-schema.sql

-- 1. Пользователи приложения (тариф: basic | master)
create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null unique,
  tariff text not null default 'basic' check (tariff in ('basic', 'master')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists idx_app_users_telegram on app_users(telegram_user_id);
comment on table app_users is 'Пользователи приложения; tariff master даёт доступ к разделу «Мои герои»';

alter table app_users disable row level security;

-- 2. Клиенты мастера («Герои»)
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null,
  birth_date date,
  birth_time time,
  birth_place text,
  birthtime_unknown boolean default false,
  gender text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_clients_user on clients(user_id);
create index if not exists idx_clients_name on clients(name);
create index if not exists idx_clients_created on clients(created_at desc);
comment on table clients is 'Картотека клиентов (героев) мастера; привязка к app_users';

alter table clients disable row level security;

-- 3. Привязка заявки к клиенту (для кого создана песня)
alter table track_requests add column if not exists client_id uuid references clients(id) on delete set null;
create index if not exists idx_track_requests_client on track_requests(client_id);
comment on column track_requests.client_id is 'Если задан — заявка создана для этого героя; данные для генерации из clients';

-- Опционально: триггер обновления updated_at для app_users и clients
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_users_updated_at on app_users;
create trigger app_users_updated_at before update on app_users
  for each row execute function set_updated_at();

drop trigger if exists clients_updated_at on clients;
create trigger clients_updated_at before update on clients
  for each row execute function set_updated_at();
