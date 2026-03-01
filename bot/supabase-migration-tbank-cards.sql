-- Таблица для хранения привязанных карт T-Bank (RebillId для рекуррентных платежей)
CREATE TABLE IF NOT EXISTS tbank_cards (
  id BIGSERIAL PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL UNIQUE,
  rebill_id TEXT NOT NULL,
  card_pan TEXT,
  card_exp TEXT,
  card_id TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tbank_cards_user ON tbank_cards(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_tbank_cards_active ON tbank_cards(telegram_user_id, active) WHERE active = TRUE;

-- Добавляем колонку tbank_payment_id в track_requests (если ещё нет)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'track_requests' AND column_name = 'tbank_payment_id'
  ) THEN
    ALTER TABLE track_requests ADD COLUMN tbank_payment_id TEXT;
  END IF;
END $$;
