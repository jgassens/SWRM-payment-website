-- Updates expired early-bird booth pricing in the already-seeded production database.
UPDATE packages SET price_cents = 50000, label = 'after Oct 15', updated_at = CURRENT_TIMESTAMP WHERE id = 'booth-academic-grad';
UPDATE packages SET price_cents = 50000, label = 'after Oct 5', updated_at = CURRENT_TIMESTAMP WHERE id = 'booth-nonprofit';
