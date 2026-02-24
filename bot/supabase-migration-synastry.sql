-- Синастрия: вторая карточка в сессиях Soul Chat
alter table soul_chat_sessions
  add column if not exists request_id_2 uuid;

comment on column soul_chat_sessions.request_id_2 is
  'Вторая карточка при синастрии (две отдельные карточки)';
