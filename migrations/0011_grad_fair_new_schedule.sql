-- Updates the Academic / Grad Fair booth description to the new schedule
-- (Monday, Nov 16 through Wednesday, Nov 18) in the already-seeded production
-- database; the catalog.js edit alone does not reach production.
UPDATE packages
SET summary = 'Lower-cost booth package for academic and grad-fair exhibitors. Graduate Recruitment Fair: Monday, November 16 through Wednesday, November 18, 2026.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-academic-grad';
