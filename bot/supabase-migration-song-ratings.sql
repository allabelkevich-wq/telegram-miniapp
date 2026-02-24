-- Рейтинги песен: оценка от 1 до 5 после прослушивания
create table if not exists song_ratings (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references track_requests(id) on delete cascade,
  telegram_user_id bigint not null,
  rating       int  not null check (rating between 1 and 5),
  created_at   timestamptz not null default now(),
  unique (request_id, telegram_user_id)
);

comment on table song_ratings is 'Оценки треков пользователями (1-5 звёзд)';
create index if not exists song_ratings_user_idx on song_ratings(telegram_user_id);
create index if not exists song_ratings_created_idx on song_ratings(created_at desc);
