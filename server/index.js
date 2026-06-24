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
const demoStripeSecret = resolveDemoStripeSecret(process.env);
const demoStripe = isStripeTestSecret(demoStripeSecret)
  ? new Stripe(demoStripeSecret, { apiVersion: "2026-02-25.clover" })
  : null;
const requiredVendorMessage = "Organization, contact name, email, phone, and website are required before checkout.";
const liveCheckoutExpirySeconds = 31 * 60;

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const headers = req.path.startsWith("/api") ? apiSecurityHeaders() : appSecurityHeaders();
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripeMode: stripe ? "checkout" : "mock",
    stripeDemoMode: demoStripe ? "test-checkout" : "missing-test-secret",
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

    if (!hasRequiredVendorFields(cleanVendor)) {
      return res.status(400).json({
        error: requiredVendorMessage
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
      expires_at: Math.floor(Date.now() / 1000) + liveCheckoutExpirySeconds,
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

app.post("/api/create-demo-checkout-session", async (req, res) => {
  try {
    const { cart, vendor, demoOrderId } = req.body || {};
    const items = normalizeCart(cart);
    const cleanVendor = normalizeVendor(vendor);

    if (items.length === 0) {
      return res.status(400).json({ error: "Select at least one sponsorship item." });
    }

    if (!hasRequiredVendorFields(cleanVendor)) {
      return res.status(400).json({
        error: requiredVendorMessage
      });
    }

    if (!demoStripe) {
      return res.status(503).json({
        error: "Stripe demo checkout needs a test-mode Stripe secret key."
      });
    }

    const orderId = clean(demoOrderId).slice(0, 120) || `demo_${Date.now().toString(36)}`;
    const encodedOrderId = encodeURIComponent(orderId);
    const origin = process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await demoStripe.checkout.sessions.create({
      mode: "payment",
      customer_email: cleanVendor.email,
      payment_intent_data: {
        receipt_email: cleanVendor.email
      },
      invoice_creation: {
        enabled: true
      },
      client_reference_id: orderId,
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
        reservation_id: orderId,
        checkout_mode: "demo",
        organization: cleanVendor.organization,
        contact_name: cleanVendor.contactName,
        phone: cleanVendor.phone || "",
        website: cleanVendor.website || "",
        package_summary: items
          .map(({ item, quantity }) => `${quantity}x ${item.name}`)
          .join("; ")
          .slice(0, 500)
      },
      success_url: `${origin}/?checkout=success&demo=1&stripe_demo=1&demo_order=${encodedOrderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel&demo=1&stripe_demo=1&demo_order=${encodedOrderId}`
    });

    return res.json({ mode: "demo-checkout", url: session.url });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Demo checkout could not be started. Please review the cart and try again."
    });
  }
});

app.post("/api/confirm-checkout-session", async (req, res) => {
  try {
    const sessionId = clean(req.body?.sessionId);

    if (!sessionId || !sessionId.startsWith("cs_")) {
      return res.status(400).json({ error: "A valid Stripe Checkout Session ID is required." });
    }

    if (!stripe) {
      return res.status(503).json({ error: "Stripe checkout is not configured." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent", "customer", "invoice"]
    });
    const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";

    return res.json({
      recorded: false,
      paid,
      reservationId: session.metadata?.reservation_id || "",
      sessionId: session.id,
      status: session.status || "",
      paymentStatus: session.payment_status || ""
    });
  } catch (error) {
    console.error(error);
    return res.status(502).json({
      error: "Stripe could not confirm that Checkout Session."
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

function apiSecurityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function appSecurityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' https://swrm-payment-checkout.jgassens.workers.dev http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self' https://checkout.stripe.com; object-src 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function normalizeCart(cart) {
  if (!Array.isArray(cart)) return [];

  // Merge duplicate ids so each package is a single line item (matches the Worker).
  const merged = new Map();
  for (const entry of cart) {
    const item = catalogById.get(String(entry?.id || ""));
    if (!item) continue;
    const quantity = Math.max(1, Math.min(Number(entry?.quantity) || 1, 99));
    const existing = merged.get(item.id);
    if (existing) {
      existing.quantity = Math.min(99, existing.quantity + quantity);
    } else {
      merged.set(item.id, { item, quantity });
    }
  }

  return Array.from(merged.values());
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

function hasRequiredVendorFields(vendor) {
  return Boolean(vendor.organization && vendor.contactName && vendor.email && vendor.phone && vendor.website);
}

function clean(value) {
  return String(value || "").trim().slice(0, 500);
}

function isStripeTestSecret(value) {
  return String(value || "").trim().startsWith("sk_test_");
}

function resolveDemoStripeSecret(env) {
  const dedicatedDemoSecret = String(env.STRIPE_DEMO_SECRET_KEY || "").trim();
  if (isStripeTestSecret(dedicatedDemoSecret)) return dedicatedDemoSecret;

  const configuredCheckoutSecret = String(env.STRIPE_SECRET_KEY || "").trim();
  return isStripeTestSecret(configuredCheckoutSecret) ? configuredCheckoutSecret : "";
}

export function summarizeOrder(items) {
  const total = items.reduce((sum, { item, quantity }) => sum + item.price * quantity, 0);
  return `${items.length} line items, ${formatCurrency(total)}`;
}
