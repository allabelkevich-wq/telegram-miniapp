-- Настройки приложения (админка): DeepSeek max_tokens и др.
-- Выполни в Supabase SQL Editor один раз. После этого в админке появится блок «Настройки генерации»:
-- можно задать max_tokens (1–8192) — значение применится к новым заявкам.

create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

comment on table app_settings is 'Настройки генерации (читает воркер, меняет админка)';

alter table app_settings disable row level security;

-- Опционально: значение по умолчанию для max_tokens (воркер подставит 8192, если ключа нет)
-- insert into app_settings (key, value) values ('deepseek_max_tokens', '8192') on conflict (key) do nothing;
