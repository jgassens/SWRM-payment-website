import React, { useEffect, useMemo, useState } from "react";
import { apiUrl, readJson } from "./api.js";
import { categories, formatCurrency } from "./catalog.js";

const storedPasswordKey = "swrm-admin-password";
const demoOrderStorageKey = "swrm-demo-last-order-v1";
const demoOrdersStorageKey = "swrm-demo-orders-v1";

export default function AdminApp({ appBase, Header }) {
  const [password, setPassword] = useState(() => sessionStorage.getItem(storedPasswordKey) || "");
  const [draftPassword, setDraftPassword] = useState("");
  const [packages, setPackages] = useState([]);
  const [orders, setOrders] = useState([]);
  const [category, setCategory] = useState("all");
  const [orderQuery, setOrderQuery] = useState("");
  const [orderStatus, setOrderStatus] = useState("all");
  const [status, setStatus] = useState({ type: "idle", message: "" });
  const [loading, setLoading] = useState(false);

  const authed = Boolean(password);
  const visiblePackages = useMemo(
    () => packages.filter((item) => category === "all" || item.category === category),
    [packages, category]
  );
  const visibleOrders = useMemo(
    () => filterOrders(orders, orderQuery, orderStatus),
    [orders, orderQuery, orderStatus]
  );

  useEffect(() => {
    if (password) {
      loadAdmin(password);
    }
  }, []);

  async function loadAdmin(nextPassword = password) {
    setLoading(true);
    setStatus({ type: "idle", message: "" });
    const demoOrders = readStoredDemoOrders();

    const [packageResult, orderResult] = await Promise.allSettled([
      adminFetch("/api/admin/packages", nextPassword),
      adminFetch("/api/admin/orders", nextPassword)
    ]);

    if (packageResult.status === "fulfilled") {
      const packageData = packageResult.value;
      setPackages(packageData.packages.map(toDraftPackage));
    } else {
      const error = packageResult.reason;
      setStatus({ type: "error", message: error.message || "Admin login failed." });
      setLoading(false);
      if (error.status === 401 || error.status === 403) {
        sessionStorage.removeItem(storedPasswordKey);
        setPassword("");
      }
      return;
    }

    if (orderResult.status === "fulfilled") {
      setOrders([...demoOrders, ...(orderResult.value.orders || [])]);
      setStatus({ type: "success", message: "Admin catalog loaded." });
    } else {
      setOrders(demoOrders);
      setStatus({
        type: demoOrders.length > 0 ? "success" : "error",
        message:
          demoOrders.length > 0
            ? "Catalog loaded. Real orders could not be reached, but demo orders are available."
            : orderResult.reason?.message || "Catalog loaded, but orders could not be reached."
      });
    }

    setLoading(false);
  }

  async function login(event) {
    event.preventDefault();
    const nextPassword = draftPassword.trim();
    if (!nextPassword) return;
    setPassword(nextPassword);
    sessionStorage.setItem(storedPasswordKey, nextPassword);
    await loadAdmin(nextPassword);
  }

  function logout() {
    sessionStorage.removeItem(storedPasswordKey);
    setPassword("");
    setDraftPassword("");
    setPackages([]);
    setOrders([]);
  }

  function updatePackage(id, field, value) {
    setPackages((current) =>
      current.map((item) => (item.id === id ? { ...item, [field]: value, dirty: true } : item))
    );
  }

  function addPackageDraft() {
    const selectedCategory = category === "all" ? "booths" : category;
    const sortOrder = packages.reduce((max, item) => Math.max(max, Number(item.sortOrder || 0)), 0) + 10;
    const draft = toDraftPackage({
      id: `draft-${Date.now()}`,
      category: selectedCategory,
      name: "New sponsorship card",
      label: "",
      price: 0,
      priceCents: 0,
      availability: "available",
      summary: "",
      included: [],
      stockTotal: null,
      stockRemaining: null,
      active: false,
      sortOrder
    });

    setCategory(selectedCategory);
    setPackages((current) => [{ ...draft, isNew: true, dirty: true }, ...current]);
    setStatus({
      type: "success",
      message: "New draft card added. Fill it in, turn Live on when ready, then save."
    });
  }

  async function savePackage(item) {
    setStatus({ type: "idle", message: "" });
    try {
      const payload = {
        category: item.category,
        name: item.name,
        label: item.label,
        priceCents: dollarsToCents(item.price),
        availability: item.availability,
        summary: item.summary,
        included: includedTextToArray(item.includedText),
        stockTotal: parseNullableInteger(item.stockTotal),
        stockRemaining: parseNullableInteger(item.stockRemaining),
        active: item.active,
        sortOrder: parseNullableInteger(item.sortOrder) || 0
      };

      const data = await adminFetch(item.isNew ? "/api/admin/packages" : `/api/admin/packages/${encodeURIComponent(item.id)}`, password, {
        method: item.isNew ? "POST" : "PUT",
        body: JSON.stringify(payload)
      });

      setPackages((current) =>
        current.map((row) => (row.id === item.id ? toDraftPackage(data.package) : row))
      );
      setStatus({ type: "success", message: `${data.package.name} saved.` });
    } catch (error) {
      setStatus({ type: "error", message: error.message || "Package could not be saved." });
    }
  }

  async function deletePackage(item) {
    if (item.isNew) {
      setPackages((current) => current.filter((row) => row.id !== item.id));
      setStatus({ type: "success", message: "Draft card removed." });
      return;
    }

    const confirmed = window.confirm(`Delete "${item.name}" from the sponsorship catalog?`);
    if (!confirmed) return;

    setStatus({ type: "idle", message: "" });
    try {
      await adminFetch(`/api/admin/packages/${encodeURIComponent(item.id)}`, password, {
        method: "DELETE"
      });
      setPackages((current) => current.filter((row) => row.id !== item.id));
      setStatus({ type: "success", message: `${item.name} deleted.` });
    } catch (error) {
      setStatus({ type: "error", message: error.message || "Package could not be deleted." });
    }
  }

  async function releaseExpired() {
    setStatus({ type: "idle", message: "" });
    try {
      const data = await adminFetch("/api/admin/release-expired", password, { method: "POST" });
      setStatus({
        type: "success",
        message: `${data.released || 0} expired checkout hold${data.released === 1 ? "" : "s"} released.`
      });
      await loadAdmin(password);
    } catch (error) {
      setStatus({ type: "error", message: error.message || "Expired holds could not be released." });
    }
  }

  return (
    <div className="app-shell admin-app">
      <Header cartCount={0} admin />
      <main className="page admin-page">
        <section className="intro-panel admin-intro">
          <div className="accent-rule" aria-hidden="true" />
          <div className="intro-copy">
            <p className="section-label">SWRM payment admin</p>
            <h1>Catalog, prices, and inventory</h1>
            <p>
              Update sponsorship pricing, hide sold-out packages, and manage finite inventory before vendors check out.
            </p>
          </div>
          <div className="admin-actions">
            <a className="outline-button result-link" href={appBase}>
              View storefront
            </a>
            {authed ? (
              <>
                <a className="outline-button result-link" href="#vendor-order-book">
                  Vendor order book
                </a>
                <button type="button" className="outline-button" onClick={logout}>
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </section>

        {!authed ? (
          <form className="admin-login" onSubmit={login}>
            <label>
              Admin password
              <input
                type="password"
                value={draftPassword}
                onChange={(event) => setDraftPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="checkout-button">
              Open admin
            </button>
            {status.message ? <StatusMessage status={status} /> : null}
          </form>
        ) : (
          <>
            <div className="admin-toolbar">
              <div className="category-tabs admin-tabs" role="tablist" aria-label="Admin categories">
                <button
                  type="button"
                  className={category === "all" ? "tab active" : "tab"}
                  onClick={() => setCategory("all")}
                >
                  All
                </button>
                {categories.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={category === item.id ? "tab active" : "tab"}
                    onClick={() => setCategory(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="admin-command-row">
                <button type="button" className="checkout-button compact-button" onClick={addPackageDraft}>
                  New card
                </button>
                <button type="button" className="outline-button compact-button" onClick={() => loadAdmin(password)}>
                  Refresh
                </button>
                <button type="button" className="outline-button compact-button" onClick={releaseExpired}>
                  Release expired holds
                </button>
              </div>
            </div>

            {status.message ? <StatusMessage status={status} /> : null}
            {loading ? <p className="checkout-note">Loading admin catalog...</p> : null}

            <section className="admin-grid" aria-label="Editable sponsorship packages">
              {visiblePackages.map((item) => (
                <PackageEditor
                  key={item.id}
                  item={item}
                  onChange={updatePackage}
                  onSave={savePackage}
                  onDelete={deletePackage}
                />
              ))}
            </section>

            <OrderBook
              orders={visibleOrders}
              allOrders={orders}
              query={orderQuery}
              status={orderStatus}
              onQueryChange={setOrderQuery}
              onStatusChange={setOrderStatus}
            />
          </>
        )}
      </main>
    </div>
  );
}

function OrderBook({ orders, allOrders, query, status, onQueryChange, onStatusChange }) {
  const paidOrders = allOrders.filter((order) => order.status === "paid");
  const demoOrders = allOrders.filter((order) => order.status === "demo");
  const paidTotal = paidOrders.reduce((sum, order) => sum + Number(order.amountTotal || 0), 0);

  return (
    <section id="vendor-order-book" className="admin-reservations" aria-label="Orders and sponsor follow-up">
      <div className="section-heading">
        <div>
          <p className="section-label">Orders & sponsor follow-up</p>
          <h2>Vendor order book</h2>
        </div>
        <p className="deadline-note">
          Paid orders are ready for logo, ad, and sponsorship-material follow-up.
        </p>
      </div>

      <div className="order-metrics">
        <Metric value={String(allOrders.length)} label="Total sessions" />
        <Metric value={String(paidOrders.length)} label="Paid orders" />
        <Metric value={String(demoOrders.length)} label="Demo orders" />
        <Metric value={formatCents(paidTotal)} label="Paid total" />
      </div>

      <div className="order-toolbar">
        <label>
          Search orders
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Company, contact, email, package, Stripe ID"
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => onStatusChange(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="demo">Demo</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="expired">Expired</option>
          </select>
        </label>
      </div>

      {orders.length === 0 ? (
        <p className="empty-cart">No matching checkout sessions yet.</p>
      ) : (
        <div className="order-list">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      )}
    </section>
  );
}

function Metric({ value, label }) {
  return (
    <div className="order-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function OrderCard({ order }) {
  const stripeLookup = order.stripePaymentIntentId || order.stripeSessionId || order.stripeInvoiceId;
  const stripeSearchUrl = order.isDemo
    ? "https://dashboard.stripe.com/test/search"
    : "https://dashboard.stripe.com/search";
  const contactHref = `mailto:${order.email}?subject=${encodeURIComponent(
    "SWRM 2026 sponsorship logo and materials"
  )}`;

  return (
    <article className="order-card">
      <div className="order-card-main">
        <div>
          <p className={`status-pill status-${order.status || "pending"}`}>{order.status || "pending"}</p>
          <h3>{order.organization || "Unknown organization"}</h3>
          <p className="order-contact">
            {order.contactName || "No contact"} ·{" "}
            <a href={contactHref}>{order.email || "No email"}</a>
            {order.phone ? ` · ${order.phone}` : ""}
          </p>
          {order.website ? (
            <a className="order-website" href={order.website} target="_blank" rel="noreferrer">
              {order.website}
            </a>
          ) : null}
        </div>
        <div className="order-total">
          <strong>{formatCents(order.amountTotal)}</strong>
          <span>{formatReservationTime(order.createdAt)}</span>
        </div>
      </div>

      <div className="order-items">
        {(order.items || []).length > 0 ? (
          order.items.map((item) => (
            <div className="order-item" key={`${order.id}-${item.packageId}`}>
              <span>
                {item.quantity}x {item.name}
              </span>
              <strong>{formatCents(Number(item.unitAmount || 0) * Number(item.quantity || 0))}</strong>
            </div>
          ))
        ) : (
          <p>{order.packageSummary || "No item summary recorded."}</p>
        )}
      </div>

      {order.notes ? (
        <div className="order-notes">
          <span>Vendor notes</span>
          <p>{order.notes}</p>
        </div>
      ) : null}

      <div className="order-meta">
        <span>Session {order.stripeSessionId || order.id}</span>
        {order.isDemo ? <span>Demo sandbox order</span> : null}
        {order.paymentStatus ? <span>Payment {order.paymentStatus}</span> : null}
        {order.stripeInvoiceId ? <span>Invoice {order.stripeInvoiceId}</span> : null}
        {stripeLookup ? (
          <a
            href={`${stripeSearchUrl}?query=${encodeURIComponent(stripeLookup)}`}
            target="_blank"
            rel="noreferrer"
          >
            Find in Stripe
          </a>
        ) : null}
      </div>
    </article>
  );
}

function PackageEditor({ item, onChange, onSave, onDelete }) {
  const finiteStock = item.stockTotal !== "";

  return (
    <article className={item.active ? "admin-card" : "admin-card inactive"}>
      <div className="admin-card-header">
        <div>
          <p className="section-label">{item.isNew ? "New card" : item.category}</p>
          <h3>{item.name}</h3>
        </div>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={item.active}
            onChange={(event) => onChange(item.id, "active", event.target.checked)}
          />
          Live
        </label>
      </div>

      <div className="admin-form-grid">
        <label>
          Category
          <select
            value={item.category}
            onChange={(event) => onChange(item.id, "category", event.target.value)}
          >
            {categories.map((categoryOption) => (
              <option key={categoryOption.id} value={categoryOption.id}>
                {categoryOption.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Price
          <input
            type="number"
            min="0"
            step="1"
            value={item.price}
            onChange={(event) => onChange(item.id, "price", event.target.value)}
          />
        </label>
        <label>
          Availability text
          <input
            value={item.availability}
            onChange={(event) => onChange(item.id, "availability", event.target.value)}
          />
        </label>
        <label>
          Total stock
          <input
            type="number"
            min="0"
            placeholder="unlimited"
            value={item.stockTotal}
            onChange={(event) => onChange(item.id, "stockTotal", event.target.value)}
          />
        </label>
        <label>
          Remaining
          <input
            type="number"
            min="0"
            placeholder={finiteStock ? "0" : "unlimited"}
            value={item.stockRemaining}
            onChange={(event) => onChange(item.id, "stockRemaining", event.target.value)}
          />
        </label>
        <label>
          Sort order
          <input
            type="number"
            min="0"
            step="1"
            value={item.sortOrder}
            onChange={(event) => onChange(item.id, "sortOrder", event.target.value)}
          />
        </label>
        <label>
          Label
          <input
            value={item.label}
            onChange={(event) => onChange(item.id, "label", event.target.value)}
          />
        </label>
        <label>
          Name
          <input
            value={item.name}
            onChange={(event) => onChange(item.id, "name", event.target.value)}
          />
        </label>
        <label className="span-all">
          Summary
          <textarea
            value={item.summary}
            onChange={(event) => onChange(item.id, "summary", event.target.value)}
          />
        </label>
        <label className="span-all">
          Included bullets
          <textarea
            value={item.includedText}
            placeholder="One bullet per line"
            onChange={(event) => onChange(item.id, "includedText", event.target.value)}
          />
        </label>
      </div>

      <div className="admin-card-footer">
        <span>
          {item.stockRemaining === ""
            ? "Unlimited inventory"
            : `${item.stockRemaining || 0} remaining`}
        </span>
        <div className="admin-card-actions">
          <button
            type="button"
            className="outline-button compact-button danger-button"
            onClick={() => onDelete(item)}
          >
            Delete
          </button>
          <button
            type="button"
            className="outline-button compact-button"
            disabled={!item.dirty}
            onClick={() => onSave(item)}
          >
            {item.isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </article>
  );
}

function StatusMessage({ status }) {
  return (
    <p className={status.type === "error" ? "checkout-error" : "checkout-note"}>
      {status.message}
    </p>
  );
}

async function adminFetch(path, password, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const response = await fetch(apiUrl(path), {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${password}`,
        ...(options.headers || {})
      }
    });
    return await readAdminJson(response);
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Admin request timed out.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readAdminJson(response) {
  try {
    return await readJson(response);
  } catch (error) {
    error.status = response.status;
    throw error;
  }
}

function readStoredDemoOrders() {
  try {
    const rawListValue = window.localStorage.getItem(demoOrdersStorageKey);
    const rawLastValue = window.sessionStorage.getItem(demoOrderStorageKey);
    const parsedList = rawListValue ? JSON.parse(rawListValue) : [];
    const parsedLast = rawLastValue ? JSON.parse(rawLastValue) : null;
    const orders = [
      parsedLast,
      ...(Array.isArray(parsedList) ? parsedList : [])
    ].filter(Boolean);
    const uniqueOrders = new Map(orders.map((order) => [order.id, order]));
    return Array.from(uniqueOrders.values()).map(toDemoOrder).filter(Boolean);
  } catch (error) {
    return [];
  }
}

function toDemoOrder(order) {
  if (!order?.id) return null;
  const createdAt = Math.floor(Date.parse(order.createdAt || new Date().toISOString()) / 1000);
  const items = Array.isArray(order.items) ? order.items : [];

  return {
    id: order.id,
    stripeSessionId: order.stripeSessionId || "",
    status: "demo",
    paymentStatus: order.paymentStatus || (order.completedAt ? "paid" : "simulated"),
    organization: order.vendor?.organization || "Demo organization",
    contactName: order.vendor?.contactName || "",
    email: order.vendor?.email || "",
    phone: order.vendor?.phone || "",
    website: order.vendor?.website || "",
    notes: order.vendor?.notes || "",
    packageSummary: items.map((item) => `${item.quantity}x ${item.name}`).join("; "),
    amountTotal: dollarsToCents(order.total),
    currency: "usd",
    stripePaymentIntentId: "",
    stripeCustomerId: "",
    stripeInvoiceId: "",
    stripeCustomerName: "",
    stripeCustomerEmail: "",
    stripeCustomerPhone: "",
    billingAddress: {},
    createdAt,
    expiresAt: null,
    updatedAt: createdAt,
    isDemo: true,
    items: items.map((item) => ({
      packageId: item.id,
      name: item.name,
      category: "demo",
      quantity: Number(item.quantity || 0),
      unitAmount: dollarsToCents(item.price)
    }))
  };
}

function toDraftPackage(item) {
  return {
    ...item,
    category: item.category || categories[0].id,
    price: String(Math.round(Number(item.price || 0))),
    stockTotal: item.stockTotal === null || item.stockTotal === undefined ? "" : String(item.stockTotal),
    stockRemaining:
      item.stockRemaining === null || item.stockRemaining === undefined ? "" : String(item.stockRemaining),
    label: item.label || "",
    summary: item.summary || "",
    includedText: Array.isArray(item.included) ? item.included.join("\n") : "",
    sortOrder: item.sortOrder === null || item.sortOrder === undefined ? "0" : String(item.sortOrder),
    dirty: false
  };
}

function parseNullableInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function dollarsToCents(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

function includedTextToArray(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatReservationTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value * 1000));
}

function formatCents(value) {
  const cents = Number(value || 0);
  return formatCurrency(cents / 100);
}

function filterOrders(orders, query, status) {
  const normalizedQuery = query.trim().toLowerCase();

  return orders.filter((order) => {
    const statusMatches = status === "all" || order.status === status;
    if (!statusMatches) return false;
    if (!normalizedQuery) return true;

    const searchable = [
      order.organization,
      order.contactName,
      order.email,
      order.phone,
      order.website,
      order.packageSummary,
      order.stripeSessionId,
      order.stripePaymentIntentId,
      order.stripeInvoiceId,
      order.notes,
      ...(order.items || []).flatMap((item) => [item.name, item.packageId, item.category])
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchable.includes(normalizedQuery);
  });
}
