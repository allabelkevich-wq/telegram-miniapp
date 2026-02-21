-- Одноразовый бэкфилл: заявки «completed» с аудио, но без отметки о доставке (легаси / старый воркер).
-- После выполнения в админке они будут отображаться как «✓ Доставлено в чат».
-- Не трогаем delivery_failed и строки без audio_url.

update track_requests
set
  delivery_status = 'sent',
  delivered_at = coalesce(updated_at, created_at)
where
  generation_status = 'completed'
  and audio_url is not null
  and delivered_at is null
  and (delivery_status is null or delivery_status != 'failed');
