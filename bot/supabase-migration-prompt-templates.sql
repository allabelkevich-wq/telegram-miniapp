-- Миграция: система управления промптами (Этап 2 — пайплайн генерации)
-- Выполнить в Supabase SQL Editor после supabase-schema.sql (и при необходимости после supabase-migration-master-heroes.sql)

-- Таблица шаблонов промптов
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

create unique index if not exists idx_prompt_templates_name_active
  on prompt_templates(name) where is_active = true;
create index if not exists idx_prompt_templates_name on prompt_templates(name);
create index if not exists idx_prompt_templates_active on prompt_templates(is_active) where is_active = true;

comment on table prompt_templates is 'Шаблоны промптов для DeepSeek/Suno; подстановка переменных {{var_name}}';
comment on column prompt_templates.variables is 'Список имён переменных для валидации (например: astro_snapshot, name, request)';

alter table prompt_templates disable row level security;

-- Функция updated_at (если ещё нет из миграции master-heroes)
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists prompt_templates_updated_at on prompt_templates;
create trigger prompt_templates_updated_at before update on prompt_templates
  for each row execute function set_updated_at();

-- Начальные версии промптов (вставляем только если ещё нет активного шаблона с таким name)
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

-- Уникальность: только один активный шаблон на name (частичный уникальный индекс уже есть).
-- При добавлении новых версий старый можно деактивировать: update prompt_templates set is_active = false where name = '...' and id != '...';
