-- Добавить поле tg_username в user_profiles для ссылок из админки
-- Run in Supabase SQL editor

alter table user_profiles
  add column if not exists tg_username text;

comment on column user_profiles.tg_username is 'Telegram username пользователя (без @). Используется для ссылки https://t.me/username в админке.';
