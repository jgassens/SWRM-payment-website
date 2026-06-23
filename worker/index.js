import { categories, packages as seedPackages, withInventoryDefaults } from "../src/catalog.js";

const stripeApiVersion = "2026-02-25.clover";
const defaultAllowedOrigins = [
  "http://127.0.0.1:5180",
  "http://localhost:5180",
  "https://jgassens.github.io"
];
const validCategoryIds = new Set(categories.map((category) => category.id));

class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryError";
  }
}

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "HttpError";
    this.status = status;
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
            stripeDemoMode: resolveDemoStripeSecret(env)
              ? "test-checkout"
              : "missing-test-secret",
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

      if (url.pathname === "/api/create-demo-checkout-session" && request.method === "POST") {
        return await handleDemoCheckout(request, env, allowedOrigin);
      }

      if (url.pathname === "/api/confirm-checkout-session" && request.method === "POST") {
        return await handleConfirmCheckoutSession(request, env, allowedOrigin);
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
      const status =
        error instanceof InventoryError ? 409 : error instanceof HttpError ? error.status : 500;
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
            error instanceof InventoryError || error instanceof HttpError
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

async function handleDemoCheckout(request, env, origin) {
  const demoStripeSecret = resolveDemoStripeSecret(env);
  if (!demoStripeSecret) {
    return jsonResponse(
      { error: "Stripe demo checkout needs a test-mode Stripe secret key." },
      { status: 503, origin }
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

  const demoOrderId = clean(body?.demoOrderId, 120) || `demo_${crypto.randomUUID()}`;
  const session = await createCheckoutSession(env, items, vendor, demoOrderId, {
    mode: "demo",
    stripeSecret: demoStripeSecret
  });

  if (!session.url) {
    throw new Error("Stripe did not return a demo Checkout URL.");
  }

  return jsonResponse(
    { mode: "demo-checkout", url: session.url },
    { origin }
  );
}

async function handleConfirmCheckoutSession(request, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { error: "Stripe checkout is not configured." },
      { status: 503, origin }
    );
  }

  const body = await request.json().catch(() => null);
  const sessionId = clean(body?.sessionId, 500);

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return jsonResponse(
      { error: "A valid Stripe Checkout Session ID is required." },
      { status: 400, origin }
    );
  }

  const session = await retrieveCheckoutSession(env, sessionId, env.STRIPE_SECRET_KEY);
  const reservationId = session?.metadata?.reservation_id || (await findReservationId(env, session.id));
  const paid = isPaidCheckoutSession(session);
  let recorded = false;

  if (reservationId && paid) {
    await recordCompletedCheckout(env, reservationId, session);
    recorded = true;
  }

  return jsonResponse(
    {
      recorded,
      paid,
      reservationId: reservationId || "",
      sessionId: session.id || sessionId,
      status: session.status || "",
      paymentStatus: session.payment_status || ""
    },
    { origin }
  );
}

async function handleAdmin(request, env, origin, url) {
  if (url.pathname === "/api/admin/packages" && request.method === "GET") {
    const packages = await listPackages(env, { activeOnly: false });
    return jsonResponse({ packages }, { origin });
  }

  if (url.pathname === "/api/admin/packages" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const created = await createPackage(env, body || {});
    return jsonResponse({ package: created }, { status: 201, origin });
  }

  const packageMatch = url.pathname.match(/^\/api\/admin\/packages\/([^/]+)$/);
  if (packageMatch && request.method === "PUT") {
    const body = await request.json().catch(() => null);
    const updated = await updatePackage(env, decodeURIComponent(packageMatch[1]), body || {});
    return jsonResponse({ package: updated }, { origin });
  }

  if (packageMatch && request.method === "DELETE") {
    const deleted = await deletePackage(env, decodeURIComponent(packageMatch[1]));
    return jsonResponse({ package: deleted }, { origin });
  }

  if (url.pathname === "/api/admin/reservations" && request.method === "GET") {
    const reservations = await listReservations(env);
    return jsonResponse({ reservations }, { origin });
  }

  if (url.pathname === "/api/admin/orders" && request.method === "GET") {
    const orders = await listOrders(env);
    return jsonResponse({ orders }, { origin });
  }

  if (url.pathname === "/api/admin/release-expired" && request.method === "POST") {
    const released = await releaseExpiredReservations(env);
    return jsonResponse({ released }, { origin });
  }

  return jsonResponse({ error: "Not found." }, { status: 404, origin });
}

async function createCheckoutSession(env, items, vendor, reservationId, options = {}) {
  const frontendUrl = trimTrailingSlash(env.FRONTEND_URL);
  const stripeSecret = options.stripeSecret || env.STRIPE_SECRET_KEY;
  const isDemoCheckout = options.mode === "demo";
  const encodedReservationId = encodeURIComponent(reservationId);
  const form = new URLSearchParams();

  form.set("mode", "payment");
  form.set("customer_email", vendor.email);
  form.set("payment_intent_data[receipt_email]", vendor.email);
  form.set("invoice_creation[enabled]", "true");
  form.set("client_reference_id", reservationId);
  form.set(
    "success_url",
    isDemoCheckout
      ? `${frontendUrl}/?checkout=success&demo=1&stripe_demo=1&demo_order=${encodedReservationId}&session_id={CHECKOUT_SESSION_ID}`
      : `${frontendUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
  );
  form.set(
    "cancel_url",
    isDemoCheckout
      ? `${frontendUrl}/?checkout=cancel&demo=1&stripe_demo=1&demo_order=${encodedReservationId}`
      : `${frontendUrl}/?checkout=cancel`
  );
  form.set("metadata[reservation_id]", reservationId);
  form.set("metadata[checkout_mode]", isDemoCheckout ? "demo" : "live");
  form.set("metadata[organization]", vendor.organization);
  form.set("metadata[contact_name]", vendor.contactName);
  form.set("metadata[phone]", vendor.phone || "");
  form.set("metadata[website]", vendor.website || "");
  form.set("metadata[notes]", vendor.notes || "");
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
      Authorization: `Bearer ${stripeSecret}`,
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

async function retrieveCheckoutSession(env, sessionId, stripeSecret) {
  const url = new URL(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  url.searchParams.append("expand[]", "payment_intent");
  url.searchParams.append("expand[]", "customer");
  url.searchParams.append("expand[]", "invoice");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Stripe-Version": stripeApiVersion
    }
  });
  const data = await response.json();

  if (!response.ok) {
    console.error(
      JSON.stringify({
        level: "warn",
        message: "stripe_session_retrieve_rejected",
        status: response.status,
        stripeError: data?.error?.type || "unknown"
      })
    );
    throw new HttpError("Stripe could not confirm that Checkout Session.", 502);
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
    await recordCompletedCheckout(env, reservationId, session);
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
  const amountTotal = sumItems(items);
  await env.DB.prepare(`
    INSERT INTO checkout_sessions (
      id, stripe_session_id, status, organization, contact_name, email, phone, website,
      notes, package_summary, amount_total, currency, payment_status, created_at, expires_at, updated_at
    )
    VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?)
  `).bind(
    reservationId,
    session.id || "",
    vendor.organization,
    vendor.contactName,
    vendor.email,
    vendor.phone || "",
    vendor.website || "",
    vendor.notes || "",
    summarizeItems(items),
    amountTotal,
    session.payment_status || "unpaid",
    now,
    session.expires_at || null,
    now
  ).run();

  const statements = items.map(({ item, quantity }) =>
    env.DB.prepare(`
      INSERT INTO checkout_items (session_id, package_id, item_name, package_category, quantity, unit_amount)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(reservationId, item.id, item.name, item.category, quantity, item.priceCents)
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

async function listOrders(env) {
  if (!env.DB) return [];
  await ensureSchema(env.DB);

  const { results } = await env.DB.prepare(`
    SELECT id, stripe_session_id, status, payment_status, organization, contact_name, email,
           phone, website, notes, package_summary, amount_total, currency,
           stripe_payment_intent_id, stripe_customer_id, stripe_invoice_id,
           stripe_customer_name, stripe_customer_email, stripe_customer_phone,
           billing_address_json, created_at, expires_at, updated_at
    FROM checkout_sessions
    ORDER BY created_at DESC
    LIMIT 200
  `).all();

  if (results.length === 0) return [];

  const placeholders = results.map(() => "?").join(", ");
  const { results: itemRows } = await env.DB.prepare(`
    SELECT ci.session_id, ci.package_id,
           COALESCE(NULLIF(ci.item_name, ''), p.name, ci.package_id) AS item_name,
           COALESCE(NULLIF(ci.package_category, ''), p.category, '') AS package_category,
           ci.quantity, ci.unit_amount
    FROM checkout_items ci
    LEFT JOIN packages p ON p.id = ci.package_id
    WHERE ci.session_id IN (${placeholders})
    ORDER BY ci.session_id, item_name
  `).bind(...results.map((row) => row.id)).all();

  const itemsBySession = new Map();
  itemRows.forEach((row) => {
    const current = itemsBySession.get(row.session_id) || [];
    current.push({
      packageId: row.package_id,
      name: row.item_name,
      category: row.package_category,
      quantity: Number(row.quantity || 0),
      unitAmount: Number(row.unit_amount || 0)
    });
    itemsBySession.set(row.session_id, current);
  });

  return results.map((row) => ({
    id: row.id,
    stripeSessionId: row.stripe_session_id,
    status: row.status,
    paymentStatus: row.payment_status || "",
    organization: row.organization,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    website: row.website,
    notes: row.notes || "",
    packageSummary: row.package_summary,
    amountTotal: Number(row.amount_total || 0),
    currency: row.currency || "usd",
    stripePaymentIntentId: row.stripe_payment_intent_id || "",
    stripeCustomerId: row.stripe_customer_id || "",
    stripeInvoiceId: row.stripe_invoice_id || "",
    stripeCustomerName: row.stripe_customer_name || "",
    stripeCustomerEmail: row.stripe_customer_email || "",
    stripeCustomerPhone: row.stripe_customer_phone || "",
    billingAddress: parseObject(row.billing_address_json),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    items: itemsBySession.get(row.id) || []
  }));
}

async function recordCompletedCheckout(env, reservationId, session) {
  if (!env.DB || !reservationId) return;

  const now = Math.floor(Date.now() / 1000);
  const customerDetails = session?.customer_details || {};
  const billingAddress = customerDetails.address || {};

  await env.DB.prepare(`
    UPDATE checkout_sessions
    SET status = 'paid',
        stripe_session_id = COALESCE(NULLIF(?, ''), stripe_session_id),
        payment_status = ?,
        amount_total = COALESCE(?, amount_total),
        currency = COALESCE(NULLIF(?, ''), currency),
        stripe_payment_intent_id = ?,
        stripe_customer_id = ?,
        stripe_invoice_id = ?,
        stripe_customer_name = ?,
        stripe_customer_email = ?,
        stripe_customer_phone = ?,
        billing_address_json = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    clean(session.id, 500),
    session.payment_status || "paid",
    Number.isInteger(session.amount_total) ? session.amount_total : null,
    String(session.currency || "").toLowerCase(),
    stripeObjectId(session.payment_intent),
    stripeObjectId(session.customer),
    stripeObjectId(session.invoice),
    clean(customerDetails.name, 500),
    clean(customerDetails.email, 500),
    clean(customerDetails.phone, 500),
    JSON.stringify(billingAddress || {}),
    now,
    reservationId
  ).run();
}

async function updatePackage(env, id, body) {
  if (!env.DB) throw new Error("D1 is not configured.");
  await ensureSeeded(env.DB);

  const current = await env.DB.prepare("SELECT id FROM packages WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError("Package not found.", 404);
  const payload = normalizePackagePayload(body);

  await env.DB.prepare(`
    UPDATE packages
    SET category = ?,
        name = ?,
        label = ?,
        price_cents = ?,
        availability = ?,
        summary = ?,
        included_json = ?,
        stock_total = ?,
        stock_remaining = ?,
        active = ?,
        sort_order = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(
    payload.category,
    payload.name,
    payload.label,
    payload.priceCents,
    payload.availability,
    payload.summary,
    JSON.stringify(payload.included),
    payload.stockTotal,
    payload.stockRemaining,
    payload.active ? 1 : 0,
    payload.sortOrder,
    new Date().toISOString(),
    id
  ).run();

  return await getPackageById(env.DB, id);
}

async function createPackage(env, body) {
  if (!env.DB) throw new Error("D1 is not configured.");
  await ensureSeeded(env.DB);

  const payload = normalizePackagePayload(body);
  const id = await uniquePackageId(env.DB, slugify(body.id || payload.name));
  const sortOrder =
    body.sortOrder === "" || body.sortOrder === null || body.sortOrder === undefined
      ? await nextSortOrder(env.DB)
      : payload.sortOrder;

  await env.DB.prepare(`
    INSERT INTO packages (
      id, category, name, label, price_cents, availability, summary, included_json,
      stock_total, stock_remaining, active, sort_order, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    payload.category,
    payload.name,
    payload.label,
    payload.priceCents,
    payload.availability,
    payload.summary,
    JSON.stringify(payload.included),
    payload.stockTotal,
    payload.stockRemaining,
    payload.active ? 1 : 0,
    sortOrder,
    new Date().toISOString()
  ).run();

  return await getPackageById(env.DB, id);
}

async function deletePackage(env, id) {
  if (!env.DB) throw new Error("D1 is not configured.");
  await ensureSeeded(env.DB);

  const current = await getPackageById(env.DB, id);
  if (!current) throw new HttpError("Package not found.", 404);

  await env.DB.prepare("DELETE FROM packages WHERE id = ?").bind(id).run();
  return current;
}

async function getPackageById(db, id) {
  const row = await db.prepare(`
    SELECT id, category, name, label, price_cents, availability, summary, included_json,
           stock_total, stock_remaining, active, sort_order, updated_at
    FROM packages
    WHERE id = ?
  `).bind(id).first();

  return row ? mapPackageRow(row) : null;
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
      notes TEXT NOT NULL DEFAULT '',
      package_summary TEXT NOT NULL DEFAULT '',
      amount_total INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'usd',
      payment_status TEXT NOT NULL DEFAULT '',
      stripe_payment_intent_id TEXT NOT NULL DEFAULT '',
      stripe_customer_id TEXT NOT NULL DEFAULT '',
      stripe_invoice_id TEXT NOT NULL DEFAULT '',
      stripe_customer_name TEXT NOT NULL DEFAULT '',
      stripe_customer_email TEXT NOT NULL DEFAULT '',
      stripe_customer_phone TEXT NOT NULL DEFAULT '',
      billing_address_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS checkout_items (
      session_id TEXT NOT NULL,
      package_id TEXT NOT NULL,
      item_name TEXT NOT NULL DEFAULT '',
      package_category TEXT NOT NULL DEFAULT '',
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

function normalizePackagePayload(body = {}) {
  const category = clean(body.category, 80);
  const name = clean(body.name, 160);
  const stockTotal = nullableInteger(body.stockTotal);
  let stockRemaining = nullableInteger(body.stockRemaining);

  if (!validCategoryIds.has(category)) {
    throw new HttpError("Choose a valid package category.");
  }

  if (!name) {
    throw new HttpError("Package name is required.");
  }

  if (stockTotal === null) {
    stockRemaining = null;
  } else if (stockRemaining === null) {
    stockRemaining = stockTotal;
  } else if (stockRemaining > stockTotal) {
    throw new HttpError("Remaining inventory cannot be greater than total stock.");
  }

  return {
    category,
    name,
    label: clean(body.label, 160),
    priceCents: clampInteger(body.priceCents, 0, 100000000),
    availability: clean(body.availability, 160),
    summary: clean(body.summary, 700),
    included: normalizeIncluded(body.included),
    stockTotal,
    stockRemaining,
    active: body.active === false ? false : true,
    sortOrder: clampInteger(body.sortOrder, 0, 1000000)
  };
}

function normalizeIncluded(value) {
  const rawItems = Array.isArray(value) ? value : String(value || "").split("\n");
  return rawItems.map((item) => clean(item, 220)).filter(Boolean).slice(0, 12);
}

async function uniquePackageId(db, baseId) {
  const base = baseId || `custom-${crypto.randomUUID().slice(0, 8)}`;

  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base}-${index + 1}`;
    const current = await db.prepare("SELECT id FROM packages WHERE id = ?").bind(candidate).first();
    if (!current) return candidate;
  }

  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextSortOrder(db) {
  const row = await db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM packages").first();
  return Number(row?.next_order || 10);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function summarizeItems(items) {
  return items.map(({ item, quantity }) => `${quantity}x ${item.name}`).join("; ");
}

function sumItems(items) {
  return items.reduce((sum, { item, quantity }) => sum + item.priceCents * quantity, 0);
}

function normalizeVendor(vendor = {}) {
  return {
    organization: clean(vendor.organization, 500),
    contactName: clean(vendor.contactName, 500),
    email: clean(vendor.email, 500),
    phone: clean(vendor.phone, 500),
    website: clean(vendor.website, 500),
    notes: clean(vendor.notes, 1000)
  };
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stripeObjectId(value) {
  if (!value) return "";
  if (typeof value === "string") return clean(value, 500);
  if (typeof value === "object" && value.id) return clean(value.id, 500);
  return "";
}

function isPaidCheckoutSession(session) {
  return session?.payment_status === "paid" || session?.payment_status === "no_payment_required";
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
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
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
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
