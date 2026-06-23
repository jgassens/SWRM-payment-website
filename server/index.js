import "dotenv/config";
import express from "express";
import Stripe from "stripe";
import { catalogById, formatCurrency, packages, withInventoryDefaults } from "../src/catalog.js";

const app = express();
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const isProduction = process.env.NODE_ENV === "production";
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret
  ? new Stripe(stripeSecret, { apiVersion: "2026-02-25.clover" })
  : null;

app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripeMode: stripe ? "checkout" : "mock",
    catalogMode: "static"
  });
});

app.get("/api/catalog", (_req, res) => {
  res.json({
    packages: packages.map((item, index) => withInventoryDefaults(item, index))
  });
});

app.all(/^\/api\/admin\//, (_req, res) => {
  res.status(501).json({
    error: "Admin editing runs against the deployed Cloudflare Worker. Set VITE_API_BASE_URL to the Worker URL for local admin testing."
  });
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { cart, vendor } = req.body || {};
    const items = normalizeCart(cart);
    const cleanVendor = normalizeVendor(vendor);

    if (items.length === 0) {
      return res.status(400).json({ error: "Select at least one sponsorship item." });
    }

    if (!cleanVendor.organization || !cleanVendor.contactName || !cleanVendor.email) {
      return res.status(400).json({
        error: "Organization, contact name, and email are required before checkout."
      });
    }

    if (!stripe) {
      const orderId = `mock_${Date.now().toString(36)}`;
      return res.json({
        mode: "mock",
        url: `/?checkout=success&mock=1&order=${encodeURIComponent(orderId)}`
      });
    }

    const origin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: cleanVendor.email,
      client_reference_id: cleanVendor.organization.slice(0, 200),
      line_items: items.map(({ item, quantity }) => ({
        quantity,
        price_data: {
          currency: "usd",
          unit_amount: item.price * 100,
          product_data: {
            name: `SWRM 2026 - ${item.name}`,
            description: item.summary.slice(0, 300),
            metadata: {
              package_id: item.id,
              category: item.category
            }
          }
        }
      })),
      metadata: {
        organization: cleanVendor.organization,
        contact_name: cleanVendor.contactName,
        phone: cleanVendor.phone || "",
        website: cleanVendor.website || "",
        package_summary: items
          .map(({ item, quantity }) => `${quantity}x ${item.name}`)
          .join("; ")
          .slice(0, 500)
      },
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`
    });

    return res.json({ mode: "checkout", url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Checkout could not be started. Please review the cart and try again."
    });
  }
});

if (isProduction) {
  app.use(express.static("dist"));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile("index.html", { root: "dist" });
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, hmr: false },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, host, () => {
  const mode = stripe ? "Stripe Checkout" : "mock checkout";
  console.log(`SWRM sponsorship store running at http://${host}:${port} (${mode})`);
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

function normalizeCart(cart) {
  if (!Array.isArray(cart)) return [];

  return cart
    .map((entry) => {
      const item = catalogById.get(String(entry.id));
      const quantity = Math.max(1, Math.min(Number(entry.quantity) || 1, 99));
      return item ? { item, quantity } : null;
    })
    .filter(Boolean);
}

function normalizeVendor(vendor = {}) {
  return {
    organization: clean(vendor.organization),
    contactName: clean(vendor.contactName),
    email: clean(vendor.email),
    phone: clean(vendor.phone),
    website: clean(vendor.website),
    notes: clean(vendor.notes)
  };
}

function clean(value) {
  return String(value || "").trim().slice(0, 500);
}

export function summarizeOrder(items) {
  const total = items.reduce((sum, { item, quantity }) => sum + item.price * quantity, 0);
  return `${items.length} line items, ${formatCurrency(total)}`;
}
