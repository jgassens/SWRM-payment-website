-- Moves the Academic / Grad Fair booth early-bird deadline to Oct 15 (approved by
-- ACS meeting planner on 2026-10-01, for recruiters only) and posts the Graduate
-- Recruitment Fair time: Tuesday, November 17, 2026, 11 am to 3 pm.
UPDATE packages
SET label = 'early bird $350 through Oct 15; $500 after Oct 15',
    summary = 'Lower-cost booth package for academic and grad-fair exhibitors. Graduate Recruitment Fair: Tuesday, November 17, 2026, 11 am to 3 pm.',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-academic-grad';
