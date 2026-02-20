-- Статус доставки: различаем «песня готова» и «песня доставлена пользователю»
-- Проблема: ранее generation_status=completed ставился до проверки успешной отправки в Telegram.
-- Теперь: delivery_status = 'sent' только при успешном ответе sendAudio; 'failed' — при ошибке.

alter table track_requests add column if not exists delivery_status text;
-- Значения: null (ещё не отправляли), 'sent' (Telegram API ok), 'failed' (ошибка доставки)
comment on column track_requests.delivery_status is 'Статус доставки: sent=доставлено, failed=не доставлено';

create index if not exists idx_track_requests_delivery_status on track_requests (delivery_status);
