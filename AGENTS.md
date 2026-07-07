# Agent notes for this repo

## Catalog edits need a companion migration to reach production

`src/catalog.js` only *seeds* the `packages` table in Cloudflare D1 —
`ensureSeeded()` in [worker/index.js](worker/index.js) inserts rows once, the
first time the table is empty. Production's D1 has already been seeded, so
editing `catalog.js` alone (name, price, label, availability, stock) changes
nothing on the live site. The Worker serves whatever is already sitting in
D1, not whatever `catalog.js` currently says.

This bit before: a title change ("drop 8' x 10' from the standard booth
name") was made only in `catalog.js` and looked done — build passed, local
dev server showed it correctly — but the live site kept the old title until
a migration was written and applied.

Rule of thumb:
- **Changing an existing item** (price, name, label, availability, stock cap)
  → write a migration with `UPDATE packages SET ... WHERE id = '...'`, then
  run `pnpm db:migrate` against the real deployment before calling it done.
- **Adding a brand-new item** → `INSERT OR IGNORE` works fine on its own,
  since the row doesn't exist yet in the already-seeded table (see
  [migrations/0006_community_donation.sql](migrations/0006_community_donation.sql)).
- Compare against production directly if unsure whether a change landed:
  `curl https://swrm-payment-checkout.jgassens.workers.dev/api/catalog`

`catalog.js` still isn't dead weight — it's the source of truth for the
local dev harness (`server/index.js`, which imports it directly with no D1
involved) and the frontend's offline fallback catalog. It's just decoupled
from what production actually serves once D1 has been seeded once.
