-- Расшифровка карты хранится в заявке; выдаётся пользователю только после оплаты.
-- Выполни в Supabase → SQL Editor → New query → вставь → Run.

alter table track_requests add column if not exists detailed_analysis text;
alter table track_requests add column if not exists analysis_paid boolean default false;

comment on column track_requests.detailed_analysis is 'Подробный анализ натальной карты от DeepSeek; отправляется в чат только после оплаты';
comment on column track_requests.analysis_paid is 'Оплачена ли детальная расшифровка (если true — бот может отправить detailed_analysis в чат)';
