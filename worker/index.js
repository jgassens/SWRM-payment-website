import { packages as seedPackages, withInventoryDefaults } from "../src/catalog.js";

const stripeApiVersion = "2026-02-25.clover";
const defaultAllowedOrigins = [
  "http://127.0.0.1:5180",
  "http://localhost:5180",
  "https://jgassens.github.io"
];

class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryError";
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = resolveAllowedOrigin(origin, env);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(allowedOrigin)
        });
      }

      const url = new URL(request.url);

      if (origin && !allowedOrigin) {
        return jsonResponse({ error: "Origin is not allowed." }, { status: 403 });
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return jsonResponse(
          {
            ok: true,
            stripeMode: env.STRIPE_SECRET_KEY ? "checkout" : "missing-secret",
            catalogMode: env.DB ? "d1" : "static"
          },
          { origin: allowedOrigin }
        );
      }

      if (url.pathname === "/api/catalog" && request.method === "GET") {
        const packages = await listPackages(env, { activeOnly: true });
        return jsonResponse({ packages }, { origin: allowedOrigin });
      }

      if (url.pathname === "/api/create-checkout-session" && request.method === "POST") {
        return await handleCheckout(request, env, allowedOrigin);
      }

      if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const authed = await verifyAdminRequest(request, env);
        if (!authed.ok) {
          return jsonResponse({ error: authed.error }, { status: authed.status, origin: allowedOrigin });
        }
        return await handleAdmin(request, env, allowedOrigin, url);
      }

      return jsonResponse({ error: "Not found." }, { status: 404, origin: allowedOrigin });
    } catch (error) {
      const status = error instanceof InventoryError ? 409 : 500;
      console.error(
        JSON.stringify({
          level: status === 409 ? "warn" : "error",
          message: "request_failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );

      return jsonResponse(
        {
          error:
            error instanceof InventoryError
              ? error.message
              : "Request could not be completed. Please try again."
        },
        { status, origin: resolveAllowedOrigin(request.headers.get("Origin") || "", env) }
      );
    }
  }
};

async function handleCheckout(request, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { error: "Stripe checkout is not configured." },
      { status: 500, origin }
    );
  }

  const body = await request.json().catch(() => null);
  const items = await normalizeCart(body?.cart, env);
  const vendor = normalizeVendor(body?.vendor);

  if (items.length === 0) {
    return jsonResponse(
      { error: "Select at least one sponsorship item." },
      { status: 400, origin }
    );
  }

  if (!vendor.organization || !vendor.contactName || !vendor.email) {
    return jsonResponse(
      { error: "Organization, contact name, and email are required before checkout." },
      { status: 400, origin }
    );
  }

  const reservationId = crypto.randomUUID();
  let inventoryReserved = false;

  try {
    await reserveInventory(env, items);
    inventoryReserved = true;
    const session = await createCheckoutSession(env, items, vendor, reservationId);

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    await recordReservation(env, reservationId, session, items, vendor);

    return jsonResponse(
      { mode: "checkout", url: session.url },
      { origin }
    );
  } catch (error) {
    if (inventoryReserved) {
      await releaseInventory(env, items);
    }
    throw error;
  }
}

async function handleAdmin(request, env, origin, url) {
  if (url.pathname === "/api/admin/packages" && request.method === "GET") {
    const packages = await listPackages(env, { activeOnly: false });
    return jsonResponse({ packages }, { origin });
  }

  const packageMatch = url.pathname.match(/^\/api\/admin\/packages\/([^/]+)$/);
  if (packageMatch && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    const updated = await updatePackage(env, decodeURIComponent(packageMatch[1]), body || {});
    return jsonResponse({ package: updated }, { origin });
  }

  if (url.pathname === "/api/admin/reservations" && request.method === "GET") {
    const reservations = await listReservations(env);
    return jsonResponse({ reservations }, { origin });
  }

  if (url.pathname === "/api/admin/release-expired" && request.method === "POST") {
    const released = await releaseExpiredReservations(env);
    return jsonResponse({ released }, { origin });
  }

  return jsonResponse({ error: "Not found." }, { status: 404, origin });
}

async function createCheckoutSession(env, items, vendor, reservationId) {
  const frontendUrl = trimTrailingSlash(env.FRONTEND_URL);
  const form = new URLSearchParams();

  form.set("mode", "payment");
  form.set("customer_email", vendor.email);
  form.set("client_reference_id", reservationId);
  form.set("success_url", `${frontendUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${frontendUrl}/?checkout=cancel`);
  form.set("metadata[reservation_id]", reservationId);
  form.set("metadata[organization]", vendor.organization);
  form.set("metadata[contact_name]", vendor.contactName);
  form.set("metadata[phone]", vendor.phone || "");
  form.set("metadata[website]", vendor.website || "");
  form.set(
    "metadata[package_summary]",
    summarizeItems(items).slice(0, 500)
  );

  items.forEach(({ item, quantity }, index) => {
    form.set(`line_items[${index}][quantity]`, String(quantity));
    form.set(`line_items[${index}][price_data][currency]`, "usd");
    form.set(`line_items[${index}][price_data][unit_amount]`, String(item.priceCents));
    form.set(`line_items[${index}][price_data][product_data][name]`, `SWRM 2026 - ${item.name}`);
    form.set(
      `line_items[${index}][price_data][product_data][description]`,
      item.summary.slice(0, 300)
    );
    form.set(
      `line_items[${index}][price_data][product_data][metadata][package_id]`,
      item.id
    );
    form.set(
      `line_items[${index}][price_data][product_data][metadata][category]`,
      item.category
    );
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": stripeApiVersion
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: "warn",
        message: "stripe_checkout_rejected",
        status: response.status,
        stripeError: data?.error?.type || "unknown"
      })
    );
    throw new Error("Stripe rejected the Checkout Session request.");
  }

  return data;
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse({ error: "Stripe webhook secret is not configured." }, { status: 503 });
  }

  const signature = request.headers.get("Stripe-Signature") || "";
  const payload = await request.text();
  const verified = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);

  if (!verified) {
    return jsonResponse({ error: "Invalid signature." }, { status: 400 });
  }

  const event = JSON.parse(payload);
  const session = event?.data?.object || {};
  const reservationId = session?.metadata?.reservation_id || (await findReservationId(env, session.id));

  if (!reservationId) {
    return jsonResponse({ received: true, ignored: true });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    await markReservationStatus(env, reservationId, "paid");
  }

  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    await releaseReservationIfPending(env, reservationId, "expired");
  }

  return jsonResponse({ received: true });
}

async function listPackages(env, { activeOnly }) {
  if (!env.DB) {
    return seedPackages.map((item, index) => serializePackage(withInventoryDefaults(item, index)));
  }

  await ensureSeeded(env.DB);
  const query = `
    SELECT id, category, name, label, price_cents, availability, summary, included_json,
           stock_total, stock_remaining, active, sort_order, updated_at
    FROM packages
    ${activeOnly ? "WHERE active = 1" : ""}
    ORDER BY sort_order ASC, name ASC
  `;
  const { results } = await env.DB.prepare(query).all();
  return results.map(mapPackageRow);
}

async function normalizeCart(cart, env) {
  if (!Array.isArray(cart)) return [];
  const packageMap = new Map((await listPackages(env, { activeOnly: true })).map((item) => [item.id, item]));

  return cart
    .map((entry) => {
      const item = packageMap.get(String(entry?.id || ""));
      const quantity = Math.max(1, Math.min(Number(entry?.quantity) || 1, 99));
      return item ? { item, quantity } : null;
    })
    .filter(Boolean);
}

async function reserveInventory(env, items) {
  if (!env.DB) return;

  const reserved = [];
  const now = new Date().toISOString();

  for (const { item, quantity } of items) {
    const result = await env.DB.prepare(`
      UPDATE packages
      SET stock_remaining = CASE
          WHEN stock_remaining IS NULL THEN NULL
          ELSE stock_remaining - ?
        END,
        updated_at = ?
      WHERE id = ?
        AND active = 1
        AND (stock_remaining IS NULL OR stock_remaining >= ?)
    `).bind(quantity, now, item.id, quantity).run();

    if ((result.meta?.changes || 0) !== 1) {
      await releaseInventory(env, reserved);
      throw new InventoryError(`${item.name} is sold out or no longer has enough inventory.`);
    }

    reserved.push({ item, quantity });
  }
}

async function releaseInventory(env, items) {
  if (!env.DB || items.length === 0) return;
  const now = new Date().toISOString();

  for (const { item, quantity } of items) {
    await env.DB.prepare(`
      UPDATE packages
      SET stock_remaining = CASE
          WHEN stock_remaining IS NULL THEN NULL
          ELSE stock_remaining + ?
        END,
        updated_at = ?
      WHERE id = ?
    `).bind(quantity, now, item.id).run();
  }
}

async function recordReservation(env, reservationId, session, items, vendor) {
  if (!env.DB) return;

  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    INSERT INTO checkout_sessions (
      id, stripe_session_id, status, organization, contact_name, email, phone, website,
      package_summary, created_at, expires_at, updated_at
    )
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    reservationId,
    session.id || "",
    vendor.organization,
    vendor.contactName,
    vendor.email,
    vendor.phone || "",
    vendor.website || "",
    summarizeItems(items),
    now,
    session.expires_at || null,
    now
  ).run();

  const statements = items.map(({ item, quantity }) =>
    env.DB.prepare(`
      INSERT INTO checkout_items (session_id, package_id, quantity, unit_amount)
      VALUES (?, ?, ?, ?)
    `).bind(reservationId, item.id, quantity, item.priceCents)
  );

  if (statements.length > 0) {
    await env.DB.batch(statements);
  }
}

async function listReservations(env) {
  if (!env.DB) return [];
  await ensureSchema(env.DB);

  const { results } = await env.DB.prepare(`
    SELECT id, stripe_session_id, status, organization, contact_name, email,
           package_summary, created_at, expires_at, updated_at
    FROM checkout_sessions
    ORDER BY created_at DESC
    LIMIT 40
  `).all();

  return results.map((row) => ({
    id: row.id,
    stripeSessionId: row.stripe_session_id,
    status: row.status,
    organization: row.organization,
    contactName: row.contact_name,
    email: row.email,
    packageSummary: row.package_summary,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at
  }));
}

async function updatePackage(env, id, body) {
  if (!env.DB) throw new Error("D1 is not configured.");
  await ensureSeeded(env.DB);

  const current = await env.DB.prepare("SELECT id FROM packages WHERE id = ?").bind(id).first();
  if (!current) throw new Error("Package not found.");

  const priceCents = clampInteger(body.priceCents, 0, 100000000);
  const stockTotal = nullableInteger(body.stockTotal);
  let stockRemaining = nullableInteger(body.stockRemaining);

  if (stockTotal === null) {
    stockRemaining = null;
  } else if (stockRemaining === null) {
    stockRemaining = stockTotal;
  } else if (stockRemaining > stockTotal) {
    throw new Error("Remaining inventory cannot be greater than total stock.");
  }

  await env.DB.prepare(`
    UPDATE packages
    SET name = ?,
        label = ?,
        price_cents = ?,
        availability = ?,
        summary = ?,
        stock_total = ?,
        stock_remaining = ?,
        active = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    clean(body.name, 160),
    clean(body.label, 160),
    priceCents,
    clean(body.availability, 160),
    clean(body.summary, 700),
    stockTotal,
    stockRemaining,
    body.active === false ? 0 : 1,
    new Date().toISOString(),
    id
  ).run();

  const row = await env.DB.prepare(`
    SELECT id, category, name, label, price_cents, availability, summary, included_json,
           stock_total, stock_remaining, active, sort_order, updated_at
    FROM packages
    WHERE id = ?
  `).bind(id).first();

  return mapPackageRow(row);
}

async function releaseExpiredReservations(env) {
  if (!env.DB) return 0;
  await ensureSchema(env.DB);

  const now = Math.floor(Date.now() / 1000);
  const { results } = await env.DB.prepare(`
    SELECT id
    FROM checkout_sessions
    WHERE status = 'pending'
      AND expires_at IS NOT NULL
      AND expires_at < ?
    LIMIT 100
  `).bind(now).all();

  let released = 0;
  for (const row of results) {
    const didRelease = await releaseReservationIfPending(env, row.id, "expired");
    if (didRelease) released += 1;
  }
  return released;
}

async function releaseReservationIfPending(env, reservationId, nextStatus) {
  if (!env.DB || !reservationId) return false;
  const session = await env.DB.prepare("SELECT status FROM checkout_sessions WHERE id = ?").bind(reservationId).first();
  if (!session || session.status !== "pending") return false;

  const { results } = await env.DB.prepare(`
    SELECT package_id, quantity
    FROM checkout_items
    WHERE session_id = ?
  `).bind(reservationId).all();

  const items = results.map((row) => ({
    item: { id: row.package_id },
    quantity: row.quantity
  }));

  await releaseInventory(env, items);
  await markReservationStatus(env, reservationId, nextStatus);
  return true;
}

async function markReservationStatus(env, reservationId, status) {
  if (!env.DB || !reservationId) return;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(`
    UPDATE checkout_sessions
    SET status = ?, updated_at = ?
    WHERE id = ?
  `).bind(status, now, reservationId).run();
}

async function findReservationId(env, stripeSessionId) {
  if (!env.DB || !stripeSessionId) return "";
  const row = await env.DB.prepare(`
    SELECT id
    FROM checkout_sessions
    WHERE stripe_session_id = ?
  `).bind(stripeSessionId).first();
  return row?.id || "";
}

async function ensureSeeded(db) {
  await ensureSchema(db);
  const countRow = await db.prepare("SELECT COUNT(*) AS count FROM packages").first();
  if (Number(countRow?.count || 0) > 0) return;

  const statements = seedPackages.map((item, index) => {
    const seed = withInventoryDefaults(item, index);
    return db.prepare(`
      INSERT OR IGNORE INTO packages (
        id, category, name, label, price_cents, availability, summary, included_json,
        stock_total, stock_remaining, active, sort_order, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      seed.id,
      seed.category,
      seed.name,
      seed.label || "",
      seed.priceCents,
      seed.availability,
      seed.summary,
      JSON.stringify(seed.included || []),
      seed.stockTotal,
      seed.stockRemaining,
      seed.sortOrder,
      new Date().toISOString()
    );
  });

  if (statements.length > 0) {
    await db.batch(statements);
  }
}

async function ensureSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      label TEXT,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      availability TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      included_json TEXT NOT NULL DEFAULT '[]',
      stock_total INTEGER CHECK (stock_total IS NULL OR stock_total >= 0),
      stock_remaining INTEGER CHECK (stock_remaining IS NULL OR stock_remaining >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS checkout_sessions (
      id TEXT PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      organization TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      package_summary TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS checkout_items (
      session_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_amount INTEGER NOT NULL CHECK (unit_amount >= 0),
      PRIMARY KEY (session_id, package_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_packages_active_sort ON packages(active, sort_order)",
    "CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_expires ON checkout_sessions(status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_checkout_sessions_stripe ON checkout_sessions(stripe_session_id)"
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
}

function mapPackageRow(row) {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    label: row.label || "",
    price: Number(row.price_cents || 0) / 100,
    priceCents: Number(row.price_cents || 0),
    availability: row.availability || "",
    summary: row.summary || "",
    included: parseIncluded(row.included_json),
    stockTotal: row.stock_total === null || row.stock_total === undefined ? null : Number(row.stock_total),
    stockRemaining:
      row.stock_remaining === null || row.stock_remaining === undefined ? null : Number(row.stock_remaining),
    active: row.active !== 0,
    sortOrder: Number(row.sort_order || 0),
    updatedAt: row.updated_at
  };
}

function serializePackage(item) {
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    label: item.label || "",
    price: item.price,
    priceCents: item.priceCents,
    availability: item.availability,
    summary: item.summary,
    included: item.included || [],
    stockTotal: item.stockTotal,
    stockRemaining: item.stockRemaining,
    active: item.active !== false,
    sortOrder: item.sortOrder
  };
}

function parseIncluded(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function summarizeItems(items) {
  return items.map(({ item, quantity }) => `${quantity}x ${item.name}`).join("; ");
}

function normalizeVendor(vendor = {}) {
  return {
    organization: clean(vendor.organization, 500),
    contactName: clean(vendor.contactName, 500),
    email: clean(vendor.email, 500),
    phone: clean(vendor.phone, 500),
    website: clean(vendor.website, 500)
  };
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function clampInteger(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function nullableInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function trimTrailingSlash(value) {
  return String(value || "https://jgassens.github.io/SWRM-payment-website").replace(/\/+$/, "");
}

async function verifyAdminRequest(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return { ok: false, status: 503, error: "Admin password is not configured." };
  }

  const header = request.headers.get("Authorization") || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  const valid = await verifySecret(provided, env.ADMIN_PASSWORD);

  return valid
    ? { ok: true }
    : { ok: false, status: 401, error: "Admin password is incorrect." };
}

async function verifySecret(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  return constantTimeEqualBytes(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((part) => part.split("="))
      .filter((part) => part.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()])
  );
  const timestamp = Number(parts.t || 0);
  const signature = parts.v1 || "";

  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`));
  return constantTimeEqualHex(bufferToHex(digest), signature);
}

function constantTimeEqualHex(left, right) {
  const encoder = new TextEncoder();
  return constantTimeEqualBytes(encoder.encode(left), encoder.encode(right));
}

function constantTimeEqualBytes(left, right) {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }

  return diff === 0;
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function resolveAllowedOrigin(origin, env) {
  if (!origin) return "";

  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const origins = allowed.length > 0 ? allowed : defaultAllowedOrigins;
  return origins.includes(origin) ? origin : "";
}

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    Vary: "Origin"
  };

  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(options.origin || "")
    }
  });
}
