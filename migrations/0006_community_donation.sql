-- Adds a $1 "anonymous donation" package. Primarily a low-cost way to verify a real
-- end-to-end live transaction, but it is a valid package vendors can also purchase.
-- INSERT OR IGNORE keeps this safe to re-run and harmless if the row already exists.
INSERT OR IGNORE INTO packages (
  id, category, name, label, price_cents, availability, summary, included_json,
  stock_total, stock_remaining, active, sort_order, updated_at
) VALUES (
  'community-donation',
  'student',
  'Anonymously donate to support our conference',
  '',
  100,
  'unlimited',
  'Make a $1 contribution to help fund SWRM 2026 programming and student participation.',
  '["Supports SWRM 2026 conference programming"]',
  NULL,
  NULL,
  1,
  100,
  CURRENT_TIMESTAMP
);
