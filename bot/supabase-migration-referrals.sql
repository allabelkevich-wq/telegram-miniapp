-- =============================================================================
-- МИГРАЦИЯ: Реферальная система YupSoul
-- Supabase → SQL Editor → New query → вставь этот файл целиком → Run.
-- =============================================================================

-- 1. Новая таблица рефералов
CREATE TABLE IF NOT EXISTS referrals (
  id                UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       BIGINT    NOT NULL,
  referee_id        BIGINT    NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  activated_at      TIMESTAMPTZ,
  reward_granted    BOOLEAN   DEFAULT FALSE,
  reward_granted_at TIMESTAMPTZ
);

-- Один пользователь может быть рефералом только одного реферера
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referee  ON referrals(referee_id);
CREATE INDEX        IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
ALTER TABLE referrals DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE referrals IS 'Реферальные связи: кто кого пригласил и выдана ли награда';

-- 2. Три новых колонки в user_profiles
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_code    TEXT    UNIQUE;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referred_by      TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS referral_credits INTEGER DEFAULT 0;

COMMENT ON COLUMN user_profiles.referral_code    IS 'Персональный реферальный код пользователя (6 символов, напр. A3K9PX)';
COMMENT ON COLUMN user_profiles.referred_by      IS 'Реферальный код пользователя, который пригласил этого';
COMMENT ON COLUMN user_profiles.referral_credits IS 'Количество накопленных бесплатных генераций за рефералов';
