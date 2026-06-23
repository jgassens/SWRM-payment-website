ALTER TABLE checkout_sessions ADD COLUMN checkout_mode TEXT NOT NULL DEFAULT 'live';

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_mode ON checkout_sessions(checkout_mode);

UPDATE checkout_sessions
SET checkout_mode = 'demo',
    status = CASE WHEN status = 'paid' THEN 'demo' ELSE status END
WHERE stripe_session_id LIKE 'cs_test_%';
