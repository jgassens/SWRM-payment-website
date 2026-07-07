-- Drops "8' x 10'" from the standard commercial booth name in the already-seeded
-- production database (catalog.js was updated earlier but that edit alone never
-- reached production, since the seed only runs once on an empty table).
UPDATE packages
SET name = 'Standard commercial booth',
    updated_at = CURRENT_TIMESTAMP
WHERE id IN ('booth-standard-early', 'booth-standard');
