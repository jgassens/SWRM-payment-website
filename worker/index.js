import { categories, packages as seedPackages, withInventoryDefaults } from "../src/catalog.js";

const stripeApiVersion = "2026-02-25.clover";
const defaultAllowedOrigins = [
  "http://127.0.0.1:5180",
  "http://localhost:5180",
  "https://jgassens.github.io"
];
const validCategoryIds = new Set(categories.map((category) => category.id));
const requiredVendorMessage = "Organization, contact name, email, phone, and website are required before checkout.";
const emailVerificationRequiredMessage = "Verify the vendor email address before checkout.";
const defaultEmailFrom = "noreplySWRM2026@jeremiahsrandom.website";
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
const rateLimitPolicies = {
  checkout: {
    limit: 8,
    windowSeconds: 10 * 60,
    message: "Too many checkout attempts. Please wait a few minutes and try again."
  },
  demoCheckout: {
    limit: 20,
    windowSeconds: 10 * 60,
    message: "Too many demo checkout attempts. Please wait a few minutes and try again."
  },
  emailVerification: {
    limit: 6,
    windowSeconds: 10 * 60,
    message: "Too many verification emails requested. Please wait a few minutes and try again."
  },
  emailConfirmation: {
    limit: 15,
    windowSeconds: 10 * 60,
    message: "Too many verification attempts. Please wait a few minutes and try again."
  },
  admin: {
    limit: 8,
    windowSeconds: 15 * 60,
    message: "Too many admin login attempts. Please wait and try again."
  }
};
let schemaReady = false;
let seedReady = false;

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

      if (url.pathname === "/api/email-verifications" && request.method === "POST") {
        return await handleCreateEmailVerification(request, env, allowedOrigin);
      }

      if (url.pathname === "/api/email-verifications/confirm" && request.method === "POST") {
        return await handleConfirmEmailVerification(request, env, allowedOrigin);
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
          return jsonResponse(
            { error: authed.error },
            {
              status: authed.status,
              origin: allowedOrigin,
              headers: authed.retryAfter ? { "Retry-After": String(authed.retryAfter) } : {}
            }
          );
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

async function handleCreateEmailVerification(request, env, origin) {
  const rateLimit = await consumeRateLimit(
    env,
    request,
    "emailVerification",
    rateLimitPolicies.emailVerification
  );
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit, origin);
  }

  const body = await request.json().catch(() => null);
  const email = normalizeEmail(body?.email);

  if (!isValidEmail(email)) {
    return jsonResponse(
      { error: "Enter a valid vendor email address." },
      { status: 400, origin }
    );
  }

  const verification = await createEmailVerification(env, email, body?.checkoutMode);

  return jsonResponse(
    {
      ok: true,
      email,
      verificationId: verification.id,
      expiresAt: verification.expiresAt,
      sent: true
    },
    { origin }
  );
}

async function handleConfirmEmailVerification(request, env, origin) {
  const rateLimit = await consumeRateLimit(
    env,
    request,
    "emailConfirmation",
    rateLimitPolicies.emailConfirmation
  );
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit, origin);
  }

  const body = await request.json().catch(() => null);
  const result = await confirmEmailVerification(env, body || {});

  return jsonResponse(
    {
      verified: true,
      email: result.email,
      verificationId: result.id,
      token: result.token,
      expiresAt: result.expiresAt
    },
    { origin }
  );
}

async function handleCheckout(request, env, origin) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { error: "Stripe checkout is not configured." },
      { status: 500, origin }
    );
  }

  const rateLimit = await consumeRateLimit(env, request, "checkout", rateLimitPolicies.checkout);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit, origin);
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

  const cartDependencyError = validateCartDependencies(items);
  if (cartDependencyError) {
    return jsonResponse({ error: cartDependencyError }, { status: 400, origin });
  }

  if (!hasRequiredVendorFields(vendor)) {
    return jsonResponse(
      { error: requiredVendorMessage },
      { status: 400, origin }
    );
  }

  const emailVerification = await requireVerifiedEmail(env, vendor, body?.emailVerification);
  const reservationId = crypto.randomUUID();
  let inventoryReserved = false;

  try {
    await reserveInventory(env, items);
    inventoryReserved = true;
    const session = await createCheckoutSession(env, items, vendor, reservationId);

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    await recordReservation(env, reservationId, session, items, vendor, {
      emailVerification
    });

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

  const rateLimit = await consumeRateLimit(env, request, "demoCheckout", rateLimitPolicies.demoCheckout);
  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit, origin);
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

  const cartDependencyError = validateCartDependencies(items);
  if (cartDependencyError) {
    return jsonResponse({ error: cartDependencyError }, { status: 400, origin });
  }

  if (!hasRequiredVendorFields(vendor)) {
    return jsonResponse(
      { error: requiredVendorMessage },
      { status: 400, origin }
    );
  }

  const emailVerification = await requireVerifiedEmail(env, vendor, body?.emailVerification);
  const demoOrderId = clean(body?.demoOrderId, 120) || `demo_${crypto.randomUUID()}`;
  const session = await createCheckoutSession(env, items, vendor, demoOrderId, {
    mode: "demo",
    stripeSecret: demoStripeSecret
  });

  if (!session.url) {
    throw new Error("Stripe did not return a demo Checkout URL.");
  }

  await recordReservation(env, demoOrderId, session, items, vendor, {
    checkoutMode: "demo",
    emailVerification
  });

  return jsonResponse(
    { mode: "demo-checkout", url: session.url },
    { origin }
  );
}

async function handleConfirmCheckoutSession(request, env, origin) {
  const body = await request.json().catch(() => null);
  const sessionId = clean(body?.sessionId, 500);

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return jsonResponse(
      { error: "A valid Stripe Checkout Session ID is required." },
      { status: 400, origin }
    );
  }

  const checkoutSecret = resolveCheckoutLookupSecret(env, sessionId);
  if (!checkoutSecret) {
    return jsonResponse(
      { error: "Stripe checkout is not configured." },
      { status: 503, origin }
    );
  }

  const session = await retrieveCheckoutSession(env, sessionId, checkoutSecret);
  const reservationId = session?.metadata?.reservation_id || (await findReservationId(env, session.id));
  const paid = isPaidCheckoutSession(session);
  let recorded = false;

  if (reservationId && paid) {
    recorded = await recordCompletedCheckout(env, reservationId, session);
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
  if (!isDemoCheckout) {
    form.set("expires_at", String(Math.floor(Date.now() / 1000) + liveCheckoutExpirySeconds));
  }
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

  // Merge duplicate ids so each package becomes a single line item. checkout_items
  // is keyed by (session_id, package_id), so un-merged duplicates would create a
  // valid Stripe session and then fail the DB insert, leaving an orphaned session.
  const merged = new Map();
  for (const entry of cart) {
    const item = packageMap.get(String(entry?.id || ""));
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

async function createEmailVerification(env, rawEmail, rawCheckoutMode) {
  if (!env.DB) {
    throw new HttpError("Email verification storage is not configured.", 503);
  }

  if (!env.EMAIL?.send) {
    throw new HttpError("Email sending is not configured on this Worker.", 503);
  }

  await ensureSchema(env.DB);

  const email = normalizeEmail(rawEmail);
  const checkoutMode = normalizeCheckoutMode(rawCheckoutMode);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + emailVerificationCodeExpirySeconds;
  const id = crypto.randomUUID();
  const code = generateVerificationCode();
  const codeSalt = randomHex(16);
  const codeHash = await sha256Hex(`${codeSalt}:${code}`);

  await env.DB.prepare(`
    INSERT INTO email_verifications (
      id, normalized_email, checkout_mode, code_hash, code_salt, expires_at,
      attempts, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).bind(
    id,
    email,
    checkoutMode,
    codeHash,
    codeSalt,
    expiresAt,
    now,
    now
  ).run();

  try {
    const sendResult = await sendVerificationEmail(env, email, code);
    await env.DB.prepare(`
      UPDATE email_verifications
      SET sent_at = ?, provider_message_id = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      now,
      clean(sendResult?.messageId, 500),
      now,
      id
    ).run();
  } catch (error) {
    const emailError = describeEmailSendError(error);
    console.error(
      JSON.stringify({
        level: "error",
        message: "email_verification_send_failed",
        email,
        errorCode: emailError.code,
        errorMessage: emailError.message
      })
    );
    await env.DB.prepare(`
      UPDATE email_verifications
      SET last_error = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      clean(`${emailError.code}: ${emailError.message}`, 1000),
      now,
      id
    ).run();
    throw new HttpError(publicEmailSendMessage(emailError), 502);
  }

  return { id, email, expiresAt };
}

async function confirmEmailVerification(env, payload) {
  if (!env.DB) {
    throw new HttpError("Email verification storage is not configured.", 503);
  }

  const id = clean(payload?.verificationId, 120);
  const email = normalizeEmail(payload?.email);
  const code = String(payload?.code || "").replace(/\D/g, "").slice(0, 6);

  if (!id || !isValidEmail(email) || code.length !== 6) {
    throw new HttpError("Enter the six-digit verification code sent to the vendor email.", 400);
  }

  await ensureSchema(env.DB);

  const row = await env.DB.prepare(`
    SELECT id, normalized_email, code_hash, code_salt, expires_at, attempts
    FROM email_verifications
    WHERE id = ? AND normalized_email = ?
  `).bind(id, email).first();

  if (!row) {
    throw new HttpError("Verification code was not found. Send a new code.", 400);
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(row.expires_at || 0) < now) {
    throw new HttpError("Verification code expired. Send a new code.", 400);
  }

  const attempts = Number(row.attempts || 0);
  if (attempts >= maxEmailVerificationAttempts) {
    throw new HttpError("Too many incorrect codes. Send a new verification code.", 429);
  }

  const codeHash = await sha256Hex(`${row.code_salt}:${code}`);
  if (!constantTimeEqualHex(codeHash, row.code_hash || "")) {
    await env.DB.prepare(`
      UPDATE email_verifications
      SET attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
    throw new HttpError("Verification code did not match.", 400);
  }

  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const tokenExpiresAt = now + emailVerificationTokenExpirySeconds;

  await env.DB.prepare(`
    UPDATE email_verifications
    SET verified_at = ?, checkout_token_hash = ?, token_expires_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(now, tokenHash, tokenExpiresAt, now, id).run();

  return { id, email, token, expiresAt: tokenExpiresAt, verifiedAt: now };
}

async function requireVerifiedEmail(env, vendor, payload) {
  if (String(env.EMAIL_VERIFICATION_REQUIRED || "true").toLowerCase() === "false") {
    return { id: "", verifiedAt: null };
  }

  if (!env.DB) {
    throw new HttpError("Email verification is required but storage is not configured.", 503);
  }

  const email = normalizeEmail(vendor.email);
  const id = clean(payload?.verificationId, 120);
  const token = clean(payload?.token, 500);

  if (!id || !token || !isValidEmail(email)) {
    throw new HttpError(emailVerificationRequiredMessage, 400);
  }

  await ensureSchema(env.DB);

  const row = await env.DB.prepare(`
    SELECT id, normalized_email, verified_at, checkout_token_hash, token_expires_at
    FROM email_verifications
    WHERE id = ? AND normalized_email = ?
  `).bind(id, email).first();

  const now = Math.floor(Date.now() / 1000);
  if (!row || !row.verified_at || Number(row.token_expires_at || 0) < now) {
    throw new HttpError(emailVerificationRequiredMessage, 400);
  }

  const tokenHash = await sha256Hex(token);
  if (!constantTimeEqualHex(tokenHash, row.checkout_token_hash || "")) {
    throw new HttpError(emailVerificationRequiredMessage, 400);
  }

  return { id: row.id, verifiedAt: Number(row.verified_at || now) };
}

async function sendVerificationEmail(env, email, code) {
  const from = clean(env.EMAIL_FROM, 320) || defaultEmailFrom;
  const subject = "SWRM 2026 sponsorship email verification code";
  const text = [
    `Your SWRM 2026 sponsorship checkout verification code is ${code}.`,
    "",
    "Enter this code on the sponsorship checkout page to continue to Stripe.",
    "The code expires in 15 minutes.",
    "",
    "If you did not request this code, you can ignore this email."
  ].join("\n");

  return await env.EMAIL.send({
    to: email,
    from,
    subject,
    text
  });
}

function describeEmailSendError(error) {
  const candidate = error && typeof error === "object" ? error : {};
  return {
    code: clean(candidate.code || candidate.name || "EMAIL_SEND_FAILED", 120),
    message: clean(candidate.message || String(error || "Email send failed."), 1000)
  };
}

function publicEmailSendMessage(error) {
  if (
    error.code === "E_SENDER_NOT_VERIFIED" ||
    error.code === "E_SENDER_DOMAIN_NOT_AVAILABLE"
  ) {
    return "Verification email is not fully configured for this sender domain yet.";
  }

  if (error.code === "E_RATE_LIMIT_EXCEEDED" || error.code === "E_DAILY_LIMIT_EXCEEDED") {
    return "Verification email sending is temporarily rate limited. Please try again later.";
  }

  return "Verification email could not be sent. Please try again.";
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

async function recordReservation(env, reservationId, session, items, vendor, options = {}) {
  if (!env.DB) return;

  const now = Math.floor(Date.now() / 1000);
  const amountTotal = sumItems(items);
  const checkoutMode = normalizeCheckoutMode(options.checkoutMode || session?.metadata?.checkout_mode);
  const emailVerification = options.emailVerification || {};
  await env.DB.prepare(`
    INSERT INTO checkout_sessions (
      id, stripe_session_id, checkout_mode, status, organization, contact_name, email, phone, website,
      notes, package_summary, amount_total, currency, payment_status,
      email_verification_id, email_verified_at, created_at, expires_at, updated_at
    )
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, ?)
  `).bind(
    reservationId,
    session.id || "",
    checkoutMode,
    vendor.organization,
    vendor.contactName,
    vendor.email,
    vendor.phone || "",
    vendor.website || "",
    vendor.notes || "",
    summarizeItems(items),
    amountTotal,
    session.payment_status || "unpaid",
    clean(emailVerification.id, 120),
    emailVerification.verifiedAt || null,
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
    SELECT id, stripe_session_id, checkout_mode, status, payment_status, organization, contact_name, email,
           phone, website, notes, package_summary, amount_total, currency,
           stripe_payment_intent_id, stripe_customer_id, stripe_invoice_id,
           stripe_customer_name, stripe_customer_email, stripe_customer_phone,
           billing_address_json, email_verification_id, email_verified_at,
           created_at, expires_at, updated_at
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

  return results.map((row) => {
    const checkoutMode =
      row.checkout_mode === "demo" || isStripeTestSessionId(row.stripe_session_id) ? "demo" : "live";
    const status = checkoutMode === "demo" && row.status === "paid" ? "demo" : row.status;

    return {
      id: row.id,
      stripeSessionId: row.stripe_session_id,
      checkoutMode,
      status,
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
      emailVerificationId: row.email_verification_id || "",
      emailVerifiedAt: row.email_verified_at ? Number(row.email_verified_at) : null,
      emailVerificationStatus: row.email_verified_at ? "verified" : "unverified",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
      isDemo: checkoutMode === "demo",
      items: itemsBySession.get(row.id) || []
    };
  });
}

async function recordCompletedCheckout(env, reservationId, session) {
  if (!env.DB || !reservationId) return false;

  const now = Math.floor(Date.now() / 1000);
  const customerDetails = session?.customer_details || {};
  const billingAddress = customerDetails.address || {};
  const checkoutMode = checkoutModeFromStripeSession(session);
  const nextStatus = checkoutMode === "demo" ? "demo" : "paid";

  const result = await env.DB.prepare(`
    UPDATE checkout_sessions
    SET status = ?,
        checkout_mode = ?,
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
    nextStatus,
    checkoutMode,
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

  return (result.meta?.changes || 0) > 0;
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
  const session = await env.DB.prepare(`
    SELECT status, checkout_mode, stripe_session_id
    FROM checkout_sessions
    WHERE id = ?
  `).bind(reservationId).first();
  if (!session || session.status !== "pending") return false;

  const isDemo = session.checkout_mode === "demo" || isStripeTestSessionId(session.stripe_session_id);

  if (isDemo) {
    await markReservationStatus(env, reservationId, nextStatus);
    return true;
  }

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
  if (seedReady) return;

  const countRow = await db.prepare("SELECT COUNT(*) AS count FROM packages").first();
  if (Number(countRow?.count || 0) > 0) {
    seedReady = true;
    return;
  }

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
  seedReady = true;
}

async function ensureSchema(db) {
  if (schemaReady) return;

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
      checkout_mode TEXT NOT NULL DEFAULT 'live',
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
      email_verification_id TEXT NOT NULL DEFAULT '',
      email_verified_at INTEGER,
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
    `CREATE TABLE IF NOT EXISTS rate_limits (
      rate_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      normalized_email TEXT NOT NULL,
      checkout_mode TEXT NOT NULL DEFAULT 'live',
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      verified_at INTEGER,
      checkout_token_hash TEXT NOT NULL DEFAULT '',
      token_expires_at INTEGER,
      sent_at INTEGER,
      provider_message_id TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_packages_active_sort ON packages(active, sort_order)",
    "CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status_expires ON checkout_sessions(status, expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_checkout_sessions_mode ON checkout_sessions(checkout_mode)",
    "CREATE INDEX IF NOT EXISTS idx_checkout_sessions_stripe ON checkout_sessions(stripe_session_id)",
    "CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at)",
    "CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(normalized_email, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(normalized_email, token_expires_at)"
  ];

  for (const statement of statements) {
    await db.prepare(statement).run();
  }
  schemaReady = true;
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

function hasRequiredVendorFields(vendor) {
  return Boolean(vendor.organization && vendor.contactName && vendor.email && vendor.phone && vendor.website);
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

function normalizeCheckoutMode(value) {
  return value === "demo" ? "demo" : "live";
}

function checkoutModeFromStripeSession(session) {
  return session?.metadata?.checkout_mode === "demo" || isStripeTestSessionId(session?.id) ? "demo" : "live";
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeEmail(value) {
  return clean(value, 320).toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

function generateVerificationCode() {
  const values = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(values);
    value = values[0];
  } while (value >= 4294000000);
  return String(value % 1000000).padStart(6, "0");
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bufferToHex(bytes);
}

async function sha256Hex(value) {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value || "")));
  return bufferToHex(digest);
}

function isStripeTestSecret(value) {
  return String(value || "").trim().startsWith("sk_test_");
}

function isStripeTestSessionId(value) {
  return String(value || "").trim().startsWith("cs_test_");
}

function resolveDemoStripeSecret(env) {
  const dedicatedDemoSecret = String(env.STRIPE_DEMO_SECRET_KEY || "").trim();
  if (isStripeTestSecret(dedicatedDemoSecret)) return dedicatedDemoSecret;

  const configuredCheckoutSecret = String(env.STRIPE_SECRET_KEY || "").trim();
  return isStripeTestSecret(configuredCheckoutSecret) ? configuredCheckoutSecret : "";
}

function resolveCheckoutLookupSecret(env, sessionId) {
  if (isStripeTestSessionId(sessionId)) {
    return resolveDemoStripeSecret(env) || String(env.STRIPE_SECRET_KEY || "").trim();
  }

  return String(env.STRIPE_SECRET_KEY || "").trim();
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

async function consumeRateLimit(env, request, scope, policy) {
  if (!env.DB) return { allowed: true, retryAfter: 0 };
  await ensureSchema(env.DB);

  const now = Math.floor(Date.now() / 1000);
  const resetAt = now + policy.windowSeconds;
  const rateKey = await rateLimitKey(env, request, scope);
  const current = await env.DB.prepare(`
    SELECT count, reset_at
    FROM rate_limits
    WHERE rate_key = ?
  `).bind(rateKey).first();

  if (!current || Number(current.reset_at || 0) <= now) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO rate_limits (rate_key, scope, count, reset_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
    `).bind(rateKey, scope, resetAt, now).run();
    return { allowed: true, retryAfter: 0 };
  }

  const nextCount = Number(current.count || 0) + 1;
  await env.DB.prepare(`
    UPDATE rate_limits
    SET count = ?, updated_at = ?
    WHERE rate_key = ?
  `).bind(nextCount, now, rateKey).run();

  const retryAfter = Math.max(1, Number(current.reset_at || now) - now);
  return {
    allowed: nextCount <= policy.limit,
    retryAfter,
    message: policy.message
  };
}

async function readRateLimit(env, request, scope, policy) {
  if (!env.DB) return { allowed: true, retryAfter: 0 };
  await ensureSchema(env.DB);

  const now = Math.floor(Date.now() / 1000);
  const rateKey = await rateLimitKey(env, request, scope);
  const current = await env.DB.prepare(`
    SELECT count, reset_at
    FROM rate_limits
    WHERE rate_key = ?
  `).bind(rateKey).first();

  if (!current || Number(current.reset_at || 0) <= now || Number(current.count || 0) < policy.limit) {
    return { allowed: true, retryAfter: 0 };
  }

  return {
    allowed: false,
    retryAfter: Math.max(1, Number(current.reset_at || now) - now),
    message: policy.message
  };
}

async function clearRateLimit(env, request, scope) {
  if (!env.DB) return;
  await ensureSchema(env.DB);
  const rateKey = await rateLimitKey(env, request, scope);
  await env.DB.prepare("DELETE FROM rate_limits WHERE rate_key = ?").bind(rateKey).run();
}

async function rateLimitKey(env, request, scope) {
  const clientIp =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "";
  const client = clientIp || `ua:${request.headers.get("User-Agent") || "unknown-client"}`;
  const salt = String(env.RATE_LIMIT_SALT || env.ADMIN_PASSWORD || "swrm-payment-store");
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}|${scope}|${client}`));
  return `${scope}:${bufferToHex(digest)}`;
}

function rateLimitResponse(rateLimit, origin) {
  return jsonResponse(
    { error: rateLimit.message || "Too many requests. Please try again later." },
    {
      status: 429,
      origin,
      headers: { "Retry-After": String(rateLimit.retryAfter || 60) }
    }
  );
}

async function verifyAdminRequest(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return { ok: false, status: 503, error: "Admin password is not configured." };
  }

  const currentLimit = await readRateLimit(env, request, "admin", rateLimitPolicies.admin);
  if (!currentLimit.allowed) {
    return {
      ok: false,
      status: 429,
      error: rateLimitPolicies.admin.message,
      retryAfter: currentLimit.retryAfter
    };
  }

  const header = request.headers.get("Authorization") || "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();
  const valid = await verifySecret(provided, env.ADMIN_PASSWORD);

  if (valid) {
    await clearRateLimit(env, request, "admin");
    return { ok: true };
  }

  const failedLimit = await consumeRateLimit(env, request, "admin", rateLimitPolicies.admin);
  return failedLimit.allowed
    ? { ok: false, status: 401, error: "Admin password is incorrect." }
    : {
        ok: false,
        status: 429,
        error: rateLimitPolicies.admin.message,
        retryAfter: failedLimit.retryAfter
      };
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

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
}

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...securityHeaders(),
      ...corsHeaders(options.origin || ""),
      ...(options.headers || {})
    }
  });
}
