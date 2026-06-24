ALTER TABLE checkout_sessions ADD COLUMN email_verification_id TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN email_verified_at INTEGER;

CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  normalized_email TEXT NOT NULL,
  checkout_mode TEXT NOT NULL DEFAULT 'live',
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  checkout_token_hash TEXT NOT NULL DEFAULT '',
  token_expires_at INTEGER,
  sent_at INTEGER,
  provider_message_id TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_verifications_email
  ON email_verifications(normalized_email, created_at);

CREATE INDEX IF NOT EXISTS idx_email_verifications_token
  ON email_verifications(normalized_email, token_expires_at);
