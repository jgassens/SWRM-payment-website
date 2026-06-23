# SWRM 2026 Sponsorship Store

Online sponsorship and exhibitor checkout portal for SWRM 2026.

## Run locally

```bash
pnpm install
pnpm dev
```

Open `http://localhost:5173`.

Without `STRIPE_SECRET_KEY`, checkout runs in mock mode and redirects to a local success page. To create real Stripe Checkout Sessions, copy `.env.example` to `.env` and set `STRIPE_SECRET_KEY` to a Stripe test key.

## Stripe integration

The server creates Checkout Sessions from vetted catalog IDs in `src/catalog.js`; the client never sends arbitrary prices. Vendor registration details are attached to the Checkout Session metadata for follow-up.

## Deployment

The static storefront is built for GitHub Pages. The Stripe Checkout endpoint runs as a Cloudflare Worker so `STRIPE_SECRET_KEY` is stored as a Worker secret, not in browser code or GitHub.

```bash
pnpm worker:check
pnpm worker:deploy
pnpm exec wrangler secret put STRIPE_SECRET_KEY
pnpm exec wrangler secret put ADMIN_PASSWORD
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
```

Mutable package prices and inventory live in Cloudflare D1. Apply schema migrations with:

```bash
pnpm exec wrangler d1 migrations apply swrm-payment-store --remote
```

The admin page is available at `?admin=1`. GitHub Pages is deployed by `.github/workflows/deploy-pages.yml` on pushes to `main`. The workflow builds Vite with `VITE_BASE_PATH=/SWRM-payment-website/` and points catalog, admin, and checkout traffic at the Cloudflare Worker.
