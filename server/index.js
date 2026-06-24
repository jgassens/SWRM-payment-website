import "dotenv/config";
import { webcrypto as nodeCrypto } from "node:crypto";
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
const cryptoApi = globalThis.crypto || nodeCrypto;
const requiredVendorMessage = "Organization, contact name, email, phone, and website are required before checkout.";
const emailVerificationRequiredMessage = "Verify the vendor email address before checkout.";
const emailVerificationCodeExpirySeconds = 15 * 60;
const emailVerificationTokenExpirySeconds = 2 * 60 * 60;
const maxEmailVerificationAttempts = 5;
const liveCheckoutExpirySeconds = 31 * 60;
const boothAddonIds = new Set(["booth-premium-corner"]);
const physicalBoothIds = new Set([
  "booth-standard-early",
  "booth-standard",
  "booth-academic-grad",
  "booth-nonprofit"
]);
const boothUpgradeRequiresBoothMessage = "Premium / corner upgrade requires a booth selection.";
const localEmailVerifications = new Map();

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

app.post("/api/email-verifications", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Enter a valid vendor email address." });
    }

    const verification = await createLocalEmailVerification(email, req.body?.checkoutMode);
    console.info(`Local email verification code for ${email}: ${verification.debugCode}`);
    return res.json({
      ok: true,
      email,
      verificationId: verification.id,
      expiresAt: verification.expiresAt,
      sent: false,
      debugCode: verification.debugCode
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Verification email could not be started."
    });
  }
});

app.post("/api/email-verifications/confirm", async (req, res) => {
  try {
    const result = await confirmLocalEmailVerification(req.body || {});
    return res.json({
      verified: true,
      email: result.email,
      verificationId: result.id,
      token: result.token,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    const status = Number(error.status || 400);
    return res.status(status).json({
      error: error.message || "Verification code did not work."
    });
  }
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

    const cartDependencyError = validateCartDependencies(items);
    if (cartDependencyError) {
      return res.status(400).json({ error: cartDependencyError });
    }

    if (!hasRequiredVendorFields(cleanVendor)) {
      return res.status(400).json({
        error: requiredVendorMessage
      });
    }

    let emailVerification;
    try {
      emailVerification = await requireLocalVerifiedEmail(cleanVendor, req.body?.emailVerification);
    } catch (error) {
      return res.status(Number(error.status || 400)).json({ error: error.message });
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
        email_verification_id: emailVerification.id || "",
        email_verified_at: emailVerification.verifiedAt ? String(emailVerification.verifiedAt) : "",
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

    const cartDependencyError = validateCartDependencies(items);
    if (cartDependencyError) {
      return res.status(400).json({ error: cartDependencyError });
    }

    if (!hasRequiredVendorFields(cleanVendor)) {
      return res.status(400).json({
        error: requiredVendorMessage
      });
    }

    let emailVerification;
    try {
      emailVerification = await requireLocalVerifiedEmail(cleanVendor, req.body?.emailVerification);
    } catch (error) {
      return res.status(Number(error.status || 400)).json({ error: error.message });
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
        email_verification_id: emailVerification.id || "",
        email_verified_at: emailVerification.verifiedAt ? String(emailVerification.verifiedAt) : "",
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

function validateCartDependencies(items) {
  const itemIds = new Set(items.map(({ item }) => item.id));
  const hasBoothUpgrade = Array.from(boothAddonIds).some((id) => itemIds.has(id));
  const hasPhysicalBooth = Array.from(physicalBoothIds).some((id) => itemIds.has(id));
  return hasBoothUpgrade && !hasPhysicalBooth ? boothUpgradeRequiresBoothMessage : "";
}

async function createLocalEmailVerification(rawEmail, rawCheckoutMode) {
  const email = normalizeEmail(rawEmail);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + emailVerificationCodeExpirySeconds;
  const id = randomHex(16);
  const code = generateVerificationCode();
  const codeSalt = randomHex(16);
  const codeHash = await sha256Hex(`${codeSalt}:${code}`);

  localEmailVerifications.set(id, {
    id,
    email,
    checkoutMode: rawCheckoutMode === "demo" ? "demo" : "live",
    codeHash,
    codeSalt,
    expiresAt,
    attempts: 0,
    verifiedAt: null,
    tokenHash: "",
    tokenExpiresAt: null
  });

  return { id, email, expiresAt, debugCode: code };
}

async function confirmLocalEmailVerification(payload) {
  const id = clean(payload?.verificationId);
  const email = normalizeEmail(payload?.email);
  const code = String(payload?.code || "").replace(/\D/g, "").slice(0, 6);

  if (!id || !isValidEmail(email) || code.length !== 6) {
    throw httpError("Enter the six-digit verification code sent to the vendor email.", 400);
  }

  const verification = localEmailVerifications.get(id);
  const now = Math.floor(Date.now() / 1000);

  if (!verification || verification.email !== email) {
    throw httpError("Verification code was not found. Send a new code.", 400);
  }

  if (verification.expiresAt < now) {
    throw httpError("Verification code expired. Send a new code.", 400);
  }

  if (verification.attempts >= maxEmailVerificationAttempts) {
    throw httpError("Too many incorrect codes. Send a new verification code.", 429);
  }

  const codeHash = await sha256Hex(`${verification.codeSalt}:${code}`);
  if (!constantTimeEqualHex(codeHash, verification.codeHash)) {
    verification.attempts += 1;
    throw httpError("Verification code did not match.", 400);
  }

  const token = randomHex(32);
  verification.verifiedAt = now;
  verification.tokenHash = await sha256Hex(token);
  verification.tokenExpiresAt = now + emailVerificationTokenExpirySeconds;

  return {
    id,
    email,
    token,
    expiresAt: verification.tokenExpiresAt,
    verifiedAt: verification.verifiedAt
  };
}

async function requireLocalVerifiedEmail(vendor, payload) {
  if (String(process.env.EMAIL_VERIFICATION_REQUIRED || "true").toLowerCase() === "false") {
    return { id: "", verifiedAt: null };
  }

  const id = clean(payload?.verificationId);
  const token = clean(payload?.token);
  const email = normalizeEmail(vendor.email);

  if (!id || !token || !isValidEmail(email)) {
    throw httpError(emailVerificationRequiredMessage, 400);
  }

  const verification = localEmailVerifications.get(id);
  const now = Math.floor(Date.now() / 1000);

  if (
    !verification ||
    verification.email !== email ||
    !verification.verifiedAt ||
    !verification.tokenExpiresAt ||
    verification.tokenExpiresAt < now
  ) {
    throw httpError(emailVerificationRequiredMessage, 400);
  }

  const tokenHash = await sha256Hex(token);
  if (!constantTimeEqualHex(tokenHash, verification.tokenHash)) {
    throw httpError(emailVerificationRequiredMessage, 400);
  }

  return { id: verification.id, verifiedAt: verification.verifiedAt };
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

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function clean(value) {
  return String(value || "").trim().slice(0, 500);
}

function generateVerificationCode() {
  const values = new Uint32Array(1);
  let value = 0;
  do {
    cryptoApi.getRandomValues(values);
    value = values[0];
  } while (value >= 4294000000);
  return String(value % 1000000).padStart(6, "0");
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  cryptoApi.getRandomValues(bytes);
  return bufferToHex(bytes);
}

async function sha256Hex(value) {
  const encoder = new TextEncoder();
  const digest = await cryptoApi.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return bufferToHex(digest);
}

function constantTimeEqualHex(left, right) {
  const normalizedLeft = String(left || "");
  const normalizedRight = String(right || "");
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  let diff = normalizedLeft.length ^ normalizedRight.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (normalizedLeft.charCodeAt(index) || 0) ^ (normalizedRight.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
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
