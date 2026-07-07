-- Gives the non-profit booth the same early-bird schedule as the academic booth
-- ($350 through Aug 1, $500 after), and caps premium/corner upgrade inventory at 4.
-- Verified zero premium-corner units sold before writing this, so resetting
-- stock_remaining to 4 here is safe.
UPDATE packages
SET price_cents = 35000,
    label = 'early bird $350 through Aug 1; $500 after Aug 1',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-nonprofit';

UPDATE packages
SET stock_total = 4,
    stock_remaining = 4,
    availability = '4 available',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'booth-premium-corner';
