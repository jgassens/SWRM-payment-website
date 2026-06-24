const rawApiBase = import.meta.env.VITE_API_BASE_URL || "";

export const apiBase = rawApiBase.replace(/\/+$/, "");

export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBase}${path}`;
}

export const checkoutEndpoint =
  import.meta.env.VITE_CHECKOUT_API_URL || apiUrl("/api/create-checkout-session");

export const demoCheckoutEndpoint =
  import.meta.env.VITE_DEMO_CHECKOUT_API_URL || apiUrl("/api/create-demo-checkout-session");

export const confirmCheckoutEndpoint = apiUrl("/api/confirm-checkout-session");

export const emailVerificationEndpoint = apiUrl("/api/email-verifications");

export const emailVerificationConfirmEndpoint = apiUrl("/api/email-verifications/confirm");

export async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}
