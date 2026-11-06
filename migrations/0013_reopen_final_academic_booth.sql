UPDATE packages
SET stock_total = 1,
    stock_remaining = 1,
    label = 'final booth',
    availability = 'until Nov 8, 8:00 AM CT',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-academic-grad';
