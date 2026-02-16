-- Профили пользователей по Telegram ID (автовход, повторное использование данных)
-- Run in Supabase SQL editor

create table if not exists user_profiles (
  telegram_id bigint primary key,
  name text,
  birthdate date,
  birthplace text,
  birthtime time,
  birthtime_unknown boolean default false,
  gender text,
  language text default 'ru',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_user_profiles_telegram_id on user_profiles(telegram_id);
comment on table user_profiles is 'Профили пользователей для автовхода и предзаполнения формы';
