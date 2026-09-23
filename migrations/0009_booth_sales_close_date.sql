-- Sets the booth close date agreed by Doug Carlton on 2026-09-22: early bird
-- stays at Oct 5, booth sales close Oct 31.
--
-- The 'after Oct 5' standard booth previously carried 'available until Sep 15'.
-- That stale value was cleared to plain 'available' by a direct UPDATE against
-- production on 2026-09-22, outside the migration sequence, so this file is also
-- the first migration to record that row's availability text. Re-running it on a
-- freshly seeded database lands on the same value either way.
UPDATE packages
SET availability = 'available until Oct 31',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-standard';
