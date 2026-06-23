ALTER TABLE checkout_sessions ADD COLUMN notes TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN amount_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkout_sessions ADD COLUMN currency TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE checkout_sessions ADD COLUMN payment_status TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_payment_intent_id TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_customer_id TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_invoice_id TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_customer_email TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN stripe_customer_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_sessions ADD COLUMN billing_address_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE checkout_items ADD COLUMN item_name TEXT NOT NULL DEFAULT '';
ALTER TABLE checkout_items ADD COLUMN package_category TEXT NOT NULL DEFAULT '';
