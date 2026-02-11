-- =============================================================================
-- ВЫПОЛНИТЬ ВСЕ МИГРАЦИИ ОДНИМ ЗАПУСКОМ
-- Supabase → SQL Editor → New query → вставь этот файл целиком → Run.
-- Если таблица track_requests уже есть — скрипт безопасен (create if not exists, add column if not exists).
-- Перед запуском: сделай бэкап (Project Settings → Backups → Create manual backup).
-- =============================================================================

-- 1. Схема: track_requests + astro_snapshots + базовые колонки
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
alter table track_requests disable row level security;

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
comment on table astro_snapshots is 'Натальные карты для заявок';

alter table track_requests add column if not exists astro_snapshot_id uuid references astro_snapshots(id);
alter table track_requests add column if not exists language text;
alter table track_requests add column if not exists lyrics text;
alter table track_requests add column if not exists title text;
alter table track_requests add column if not exists audio_url text;
alter table track_requests add column if not exists suno_task_id text;
alter table track_requests add column if not exists error_message text;

-- 2. Расшифровка карты (detailed_analysis, analysis_paid)
alter table track_requests add column if not exists detailed_analysis text;
alter table track_requests add column if not exists analysis_paid boolean default false;
comment on column track_requests.detailed_analysis is 'Подробный анализ натальной карты от DeepSeek';
comment on column track_requests.analysis_paid is 'Оплачена ли детальная расшифровка';

-- 3. Промпты (prompt_templates)
create table if not exists prompt_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  variables text[] default '{}',
  is_active boolean not null default true,
  version int not null default 1,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists idx_prompt_templates_name_active on prompt_templates(name) where is_active = true;
create index if not exists idx_prompt_templates_name on prompt_templates(name);
create index if not exists idx_prompt_templates_active on prompt_templates(is_active) where is_active = true;
comment on table prompt_templates is 'Шаблоны промптов для DeepSeek/Suno';
alter table prompt_templates disable row level security;
create or replace function set_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;
drop trigger if exists prompt_templates_updated_at on prompt_templates;
create trigger prompt_templates_updated_at before update on prompt_templates for each row execute function set_updated_at();
-- Начальные шаблоны (только если ещё нет активного с таким name)
insert into prompt_templates (name, body, variables, is_active, version)
select v.name, v.body, v.variables, true, 1
from (values
  (
    'deepseek_archetype_v1'::text,
    'По натальной карте ниже выдели архетип человека в поэтическом образе (без астрологических терминов), ключевые энергии (2–3 планеты/дома/аспекта), историю души: Дар → Тень → Превращение → Миссия. Ответь структурированно: Архетип, Ключевые энергии, История души, Музыкальный контекст (настроение, метафоры).' || E'\n\n' || 'Натальная карта:' || E'\n' || '{{astro_snapshot}}' || E'\n\n' || 'Имя: {{name}}' || E'\n' || 'Запрос пользователя: {{request}}',
    array['astro_snapshot', 'name', 'request']
  ),
  (
    'deepseek_lyrics_v1'::text,
    'Напиши текст песни на русском языке по архетипу и запросу. Структура: куплет (4–6 строк), припев (4–6 строк), бридж, при необходимости инструментальный проигрыш и аутро. Стиль — персонализированный, без общих фраз. Только текст, без разметки [verse]/[chorus] в финале — просто строки.' || E'\n\n' || 'Архетип и контекст:' || E'\n' || '{{archetype}}' || E'\n\n' || 'Имя: {{name}}' || E'\n' || 'Запрос: {{request}}',
    array['archetype', 'name', 'request']
  ),
  (
    'deepseek_title_v1'::text,
    'Предложи одно короткое запоминающееся название трека (на русском) по архетипу и запросу. Только название, без кавычек и пояснений.' || E'\n\n' || 'Архетип:' || E'\n' || '{{archetype}}' || E'\n\n' || 'Запрос: {{request}}',
    array['archetype', 'request']
  ),
  (
    'suno_config_v1'::text,
    '{"style": "indie pop, atmospheric", "mood": "вдохновляющий, личный", "language": "Russian"}',
    array[]::text[]
  )
) as v(name, body, variables)
where not exists (select 1 from prompt_templates pt where pt.name = v.name and pt.is_active = true);

-- 4. Статус генерации, ответ DeepSeek, тип запроса, индексы
alter table track_requests add column if not exists generation_status text default 'pending';
alter table track_requests add column if not exists deepseek_response text;
alter table track_requests add column if not exists request_type text default 'general';
create index if not exists idx_track_requests_generation_status on track_requests (generation_status);
create index if not exists idx_track_requests_created_at on track_requests (created_at desc);

-- 5. Режим «Для двоих» и «Энергия дня»
alter table track_requests add column if not exists mode text default 'single';
alter table track_requests drop constraint if exists track_requests_mode_check;
alter table track_requests add constraint track_requests_mode_check check (mode in ('single', 'couple', 'transit'));
alter table track_requests add column if not exists person2_name text;
alter table track_requests add column if not exists person2_birthdate text;
alter table track_requests add column if not exists person2_birthplace text;
alter table track_requests add column if not exists person2_birthtime text;
alter table track_requests add column if not exists person2_birthtime_unknown boolean default false;
alter table track_requests add column if not exists person2_gender text;
alter table track_requests add column if not exists transit_date text;
alter table track_requests add column if not exists transit_time text;
alter table track_requests add column if not exists transit_location text;
alter table track_requests add column if not exists transit_intent text;
