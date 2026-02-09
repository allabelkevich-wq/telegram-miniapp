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
  language text,
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

-- Таблица натальных снапшотов (сидерическая карта Lahiri + дома Placidus)
create table if not exists astro_snapshots (
  id uuid primary key default gen_random_uuid(),
  track_request_id uuid not null references track_requests(id) on delete cascade,
  snapshot_text text not null,
  snapshot_json jsonb,
  birth_lat double precision,
  birth_lon double precision,
  birth_utc timestamptz,
  time_unknown boolean default false,
  created_at timestamptz default now()
);

create unique index if not exists idx_astro_snapshots_track_request on astro_snapshots(track_request_id);
create index if not exists idx_astro_snapshots_created on astro_snapshots(created_at desc);

comment on table astro_snapshots is 'Натальные карты (AstroSnapshot) для заявок: планеты, дома, аспекты, ретроградность';

-- Поле для привязки натального снапшота к заявке (Этап 2)
alter table track_requests add column if not exists astro_snapshot_id uuid references astro_snapshots(id);
-- Язык песни и описания (ru, en, uk и т.д.)
alter table track_requests add column if not exists language text;
-- Поля для автоматической генерации (воркер DeepSeek + Suno)
alter table track_requests add column if not exists lyrics text;
alter table track_requests add column if not exists title text;
alter table track_requests add column if not exists audio_url text;
alter table track_requests add column if not exists suno_task_id text;
alter table track_requests add column if not exists error_message text;
