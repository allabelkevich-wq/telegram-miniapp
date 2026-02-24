-- Блогерские кампании: отслеживаемые реферальные ссылки
create table if not exists blogger_campaigns (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       varchar(30) unique not null,
  notes      text,
  created_at timestamptz not null default now()
);

comment on table blogger_campaigns is 'Кампании для блогеров/партнёров с уникальными кодами';

-- Код кампании в профиле пользователя (записывается при первом входе по ссылке)
alter table user_profiles
  add column if not exists campaign_code text;

comment on column user_profiles.campaign_code is 'Код блогерской кампании из ?start=camp_CODE';
create index if not exists user_profiles_campaign_idx on user_profiles(campaign_code);
