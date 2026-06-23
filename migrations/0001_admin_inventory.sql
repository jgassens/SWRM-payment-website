CREATE TABLE IF NOT EXISTS packages (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  availability TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  included_json TEXT NOT NULL DEFAULT '[]',
  stock_total INTEGER CHECK (stock_total IS NULL OR stock_total >= 0),
  stock_remaining INTEGER CHECK (stock_remaining IS NULL OR stock_remaining >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id TEXT PRIMARY KEY,
  stripe_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  organization TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  package_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkout_items (
  session_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
  PRIMARY KEY (session_id, package_id),
  FOREIGN KEY (session_id) REFERENCES checkout_sessions(id),
  FOREIGN KEY (package_id) REFERENCES packages(id)
);

CREATE INDEX IF NOT EXISTS idx_packages_active_sort ON packages(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_expires ON checkout_sessions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_checkout_sessions_stripe ON checkout_sessions(stripe_session_id);
