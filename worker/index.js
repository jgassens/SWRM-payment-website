import { catalogById } from "../src/catalog.js";

const stripeApiVersion = "2026-02-25.clover";
const defaultAllowedOrigins = [
  "http://127.0.0.1:5180",
  "http://localhost:5180",
  "https://jgassens.github.io"
];

export default {
  async fetch(request, env) {
    try {
      const origin = request.headers.get("Origin") || "";
      const allowedOrigin = resolveAllowedOrigin(origin, env);

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders(allowedOrigin)
        });
      }

      const url = new URL(request.url);

      if (url.pathname === "/api/health" && request.method === "GET") {
        return jsonResponse(
          { ok: true, stripeMode: env.STRIPE_SECRET_KEY ? "checkout" : "missing-secret" },
          { origin: allowedOrigin }
        );
      }

      if (url.pathname !== "/api/create-checkout-session" || request.method !== "POST") {
        return jsonResponse({ error: "Not found." }, { status: 404, origin: allowedOrigin });
      }

      if (origin && !allowedOrigin) {
        return jsonResponse({ error: "Origin is not allowed." }, { status: 403 });
      }

      if (!env.STRIPE_SECRET_KEY) {
        return jsonResponse(
          { error: "Stripe checkout is not configured." },
          { status: 500, origin: allowedOrigin }
        );
      }

      const body = await request.json().catch(() => null);
      const items = normalizeCart(body?.cart);
      const vendor = normalizeVendor(body?.vendor);

      if (items.length === 0) {
        return jsonResponse(
          { error: "Select at least one sponsorship item." },
          { status: 400, origin: allowedOrigin }
        );
      }

      if (!vendor.organization || !vendor.contactName || !vendor.email) {
        return jsonResponse(
          { error: "Organization, contact name, and email are required before checkout." },
          { status: 400, origin: allowedOrigin }
        );
      }

      const session = await createCheckoutSession(env, items, vendor);

      if (!session.url) {
        return jsonResponse(
          { error: "Stripe did not return a Checkout URL." },
          { status: 502, origin: allowedOrigin }
        );
      }

      return jsonResponse(
        { mode: "checkout", url: session.url },
        { origin: allowedOrigin }
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "checkout_failed",
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );

      return jsonResponse(
        { error: "Checkout could not be started. Please review the cart and try again." },
        { status: 500, origin: resolveAllowedOrigin(request.headers.get("Origin") || "", env) }
      );
    }
  }
};

async function createCheckoutSession(env, items, vendor) {
  const frontendUrl = trimTrailingSlash(env.FRONTEND_URL);
  const form = new URLSearchParams();

  form.set("mode", "payment");
  form.set("customer_email", vendor.email);
  form.set("client_reference_id", vendor.organization.slice(0, 200));
  form.set("success_url", `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", `${frontendUrl}/cancel`);
  form.set("metadata[organization]", vendor.organization);
  form.set("metadata[contact_name]", vendor.contactName);
  form.set("metadata[phone]", vendor.phone || "");
  form.set("metadata[website]", vendor.website || "");
  form.set(
    "metadata[package_summary]",
    items.map(({ item, quantity }) => `${quantity}x ${item.name}`).join("; ").slice(0, 500)
  );

  items.forEach(({ item, quantity }, index) => {
    form.set(`line_items[${index}][quantity]`, String(quantity));
    form.set(`line_items[${index}][price_data][currency]`, "usd");
    form.set(`line_items[${index}][price_data][unit_amount]`, String(item.price * 100));
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

function normalizeCart(cart) {
  if (!Array.isArray(cart)) return [];

  return cart
    .map((entry) => {
      const item = catalogById.get(String(entry?.id || ""));
      const quantity = Math.max(1, Math.min(Number(entry?.quantity) || 1, 99));
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
    website: clean(vendor.website)
  };
}

function clean(value) {
  return String(value || "").trim().slice(0, 500);
}

function trimTrailingSlash(value) {
  return String(value || "https://jgassens.github.io/SWRM-payment-website").replace(/\/+$/, "");
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
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
