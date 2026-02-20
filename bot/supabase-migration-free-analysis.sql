-- Одна бесплатная текстовые расшифровка на пользователя (по желанию).
-- Run in Supabase → SQL Editor.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS free_analysis_used_at timestamptz;

COMMENT ON COLUMN user_profiles.free_analysis_used_at IS 'Когда пользователь впервые получил расшифровку бесплатно (одна на всё время)';
