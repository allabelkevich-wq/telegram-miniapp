-- Выполни в Supabase в браузере (не из файла).
-- Как: Supabase → твой проект → SQL Editor → New query → вставь этот текст → Run.

-- Шаг 1: таблица натальных снапшотов (если её ещё нет)
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

-- Шаг 2: колонки в track_requests
alter table track_requests add column if not exists astro_snapshot_id uuid references astro_snapshots(id);
alter table track_requests add column if not exists language text;
alter table track_requests add column if not exists lyrics text;
alter table track_requests add column if not exists title text;
alter table track_requests add column if not exists audio_url text;
alter table track_requests add column if not exists suno_task_id text;
alter table track_requests add column if not exists error_message text;
