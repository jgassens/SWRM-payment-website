import React, { useMemo, useState } from "react";
import { categories, catalogById, formatCurrency, packages } from "./catalog.js";

const appBase = import.meta.env.BASE_URL || "/";
const logoUrl = `${appBase}assets/swrm-logo.webp`;
const checkoutEndpoint =
  import.meta.env.VITE_CHECKOUT_API_URL || "/api/create-checkout-session";

const initialVendor = {
  organization: "",
  contactName: "",
  email: "",
  phone: "",
  website: "",
  notes: ""
};

export default function App() {
  const [activeCategory, setActiveCategory] = useState("tiers");
  const [cart, setCart] = useState([]);
  const [vendor, setVendor] = useState(initialVendor);
  const [checkoutState, setCheckoutState] = useState({ status: "idle", message: "" });

  const currentRoute = window.location.pathname;
  const checkoutResult = new URLSearchParams(window.location.search).get("checkout");
  if (checkoutResult === "success" || currentRoute.endsWith("/success")) {
    return <CheckoutResult status="success" />;
  }
  if (checkoutResult === "cancel" || currentRoute.endsWith("/cancel")) {
    return <CheckoutResult status="cancel" />;
  }

  const visiblePackages = useMemo(
    () => packages.filter((item) => item.category === activeCategory),
    [activeCategory]
  );
  const cartLines = useMemo(
    () =>
      cart
        .map((line) => {
          const item = catalogById.get(line.id);
          return item ? { ...line, item } : null;
        })
        .filter(Boolean),
    [cart]
  );
  const total = cartLines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);

  function addToCart(itemId) {
    setCart((lines) => {
      const existing = lines.find((line) => line.id === itemId);
      if (existing) {
        return lines.map((line) =>
          line.id === itemId ? { ...line, quantity: line.quantity + 1 } : line
        );
      }
      return [...lines, { id: itemId, quantity: 1 }];
    });
  }

  function updateQuantity(itemId, change) {
    setCart((lines) =>
      lines
        .map((line) =>
          line.id === itemId
            ? { ...line, quantity: Math.max(0, line.quantity + change) }
            : line
        )
        .filter((line) => line.quantity > 0)
    );
  }

  function updateVendor(field, value) {
    setVendor((current) => ({ ...current, [field]: value }));
  }

  async function startCheckout() {
    setCheckoutState({ status: "loading", message: "Creating checkout..." });

    try {
      const response = await fetch(checkoutEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cart, vendor })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start checkout.");
      window.location.href = data.url;
    } catch (error) {
      setCheckoutState({
        status: "error",
        message: error.message || "Checkout could not be started."
      });
    }
  }

  return (
    <div className="app-shell">
      <ConferenceHeader cartCount={cartLines.length} />
      <main className="page">
        <IntroBlock />

        <section className="commerce-grid" aria-label="SWRM sponsorship checkout">
          <div className="catalog-column">
            <div className="section-heading">
              <div>
                <p className="section-label">Tailor your investment</p>
                <h2>Sponsorship tiers and a la carte exposure</h2>
              </div>
              <p className="deadline-note">
                Logos and ad copy due September 15, 2026.
              </p>
            </div>

            <CategoryTabs
              activeCategory={activeCategory}
              onChange={setActiveCategory}
            />

            <div className="package-grid">
              {visiblePackages.map((item) => (
                <PackageCard key={item.id} item={item} onAdd={addToCart} />
              ))}
            </div>
          </div>

          <CartPanel
            vendor={vendor}
            onVendorChange={updateVendor}
            cartLines={cartLines}
            total={total}
            onQuantityChange={updateQuantity}
            onCheckout={startCheckout}
            checkoutState={checkoutState}
          />
        </section>

        <Deadlines />
      </main>
    </div>
  );
}

function ConferenceHeader({ cartCount }) {
  return (
    <header>
      <div className="announcement">
        SWRM 2026 will be at Hilton Fort Worth, Nov 16-19
      </div>
      <div className="masthead">
        <nav className="masthead-inner" aria-label="Primary">
          <a href="#packages" className="menu-link">
            Packages
          </a>
          <img
            className="conference-logo"
            src={logoUrl}
            alt="SWRM 2026 Chemistry at the Intersection of Energy, Sustainability and Biology"
          />
          <a href="#checkout" className="menu-link cart-link">
            Cart ({cartCount})
          </a>
        </nav>
      </div>
    </header>
  );
}

function IntroBlock() {
  return (
    <section className="intro-panel">
      <div className="accent-rule" aria-hidden="true" />
      <div className="intro-copy">
        <p className="section-label">American Chemical Society Southwest Regional Meeting</p>
        <h1>SWRM 2026 Sponsorship Portal</h1>
        <p>
          Chemistry at the Intersection of Energy, Sustainability, and Biology.
          Sponsor visibility, exhibitor booths, branded attendee items, and
          student support opportunities are available for the November 16-19,
          2026 meeting in downtown Fort Worth.
        </p>
      </div>
      <div className="intro-facts">
        <Fact value="~1,000" label="Expected attendees" />
        <Fact value="6" label="States served" />
        <Fact value="4" label="Days of programming" />
      </div>
    </section>
  );
}

function Fact({ value, label }) {
  return (
    <div className="fact">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function CategoryTabs({ activeCategory, onChange }) {
  return (
    <div id="packages" className="category-tabs" role="tablist" aria-label="Package categories">
      {categories.map((category) => (
        <button
          key={category.id}
          className={category.id === activeCategory ? "tab active" : "tab"}
          type="button"
          role="tab"
          aria-selected={category.id === activeCategory}
          onClick={() => onChange(category.id)}
        >
          {category.label}
        </button>
      ))}
    </div>
  );
}

function PackageCard({ item, onAdd }) {
  return (
    <article className="package-card" data-testid={`package-${item.id}`}>
      <div className="card-topline">
        <span>{item.availability}</span>
        <span>{formatCurrency(item.price)}</span>
      </div>
      <h3>{item.name}</h3>
      {item.label ? <p className="item-label">{item.label}</p> : null}
      <p className="summary">{item.summary}</p>
      <ul>
        {item.included.slice(0, 3).map((benefit) => (
          <li key={benefit}>{benefit}</li>
        ))}
      </ul>
      <button
        type="button"
        className="outline-button"
        data-testid={`add-${item.id}`}
        onClick={() => onAdd(item.id)}
      >
        Add
      </button>
    </article>
  );
}

function CartPanel({
  vendor,
  onVendorChange,
  cartLines,
  total,
  onQuantityChange,
  onCheckout,
  checkoutState
}) {
  const canCheckout =
    cartLines.length > 0 &&
    vendor.organization.trim() &&
    vendor.contactName.trim() &&
    vendor.email.trim();

  return (
    <aside id="checkout" className="cart-panel" aria-label="Vendor registration and cart">
      <div className="cart-panel-header">
        <p className="section-label">Checkout</p>
        <h2>Vendor registration</h2>
      </div>

      <div className="form-grid">
        <label>
          Organization
          <input
            value={vendor.organization}
            onChange={(event) => onVendorChange("organization", event.target.value)}
            autoComplete="organization"
          />
        </label>
        <label>
          Contact name
          <input
            value={vendor.contactName}
            onChange={(event) => onVendorChange("contactName", event.target.value)}
            autoComplete="name"
          />
        </label>
        <label>
          Email
          <input
            value={vendor.email}
            onChange={(event) => onVendorChange("email", event.target.value)}
            autoComplete="email"
            type="email"
          />
        </label>
        <label>
          Phone
          <input
            value={vendor.phone}
            onChange={(event) => onVendorChange("phone", event.target.value)}
            autoComplete="tel"
          />
        </label>
        <label className="span-all">
          Website
          <input
            value={vendor.website}
            onChange={(event) => onVendorChange("website", event.target.value)}
            autoComplete="url"
            placeholder="https://"
          />
        </label>
      </div>

      <div className="cart-block">
        <div className="cart-heading">
          <h3>Cart</h3>
          <span>{cartLines.length} items</span>
        </div>

        {cartLines.length === 0 ? (
          <p className="empty-cart">Selected sponsorship items will appear here.</p>
        ) : (
          <div className="cart-lines">
            {cartLines.map((line) => (
              <div className="cart-line" key={line.id}>
                <div>
                  <strong>{line.item.name}</strong>
                  <span>{formatCurrency(line.item.price)} each</span>
                </div>
                <div className="quantity-control" aria-label={`${line.item.name} quantity`}>
                  <button type="button" onClick={() => onQuantityChange(line.id, -1)}>
                    -
                  </button>
                  <span>{line.quantity}</span>
                  <button type="button" onClick={() => onQuantityChange(line.id, 1)}>
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="total-row">
          <span>Total</span>
          <strong>{formatCurrency(total)}</strong>
        </div>
      </div>

      <button
        type="button"
        className="checkout-button"
        onClick={onCheckout}
        disabled={!canCheckout || checkoutState.status === "loading"}
      >
        {checkoutState.status === "loading" ? "Creating checkout..." : "Proceed to checkout"}
      </button>

      {checkoutState.message ? (
        <p className={checkoutState.status === "error" ? "checkout-error" : "checkout-note"}>
          {checkoutState.message}
        </p>
      ) : null}
    </aside>
  );
}

function Deadlines() {
  const rows = [
    ["August 1, 2026", "Early-bird booth pricing deadline"],
    ["September 15, 2026", "Final booth sales close; sponsor logos and ad copy due"],
    ["October 1, 2026", "Exhibitor service kit distributed"],
    ["November 1, 2026", "Slide reel, signage, and program book sent to printer"],
    ["November 17-19, 2026", "SWRM 2026 show dates"]
  ];

  return (
    <section className="deadlines">
      <div className="section-heading">
        <div>
          <p className="section-label">Logistics & next steps</p>
          <h2>Exhibit floor and deadlines</h2>
        </div>
      </div>
      <div className="deadline-table">
        {rows.map(([date, milestone]) => (
          <div className="deadline-row" key={date}>
            <strong>{date}</strong>
            <span>{milestone}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function CheckoutResult({ status }) {
  const params = new URLSearchParams(window.location.search);
  const isMock = params.get("mock") === "1";
  const isSuccess = status === "success";

  return (
    <div className="app-shell result-shell">
      <ConferenceHeader cartCount={0} />
      <main className="page">
        <section className="intro-panel result-panel">
          <div className="accent-rule" aria-hidden="true" />
          <div className="intro-copy">
            <p className="section-label">{isSuccess ? "Checkout complete" : "Checkout canceled"}</p>
            <h1>{isSuccess ? "Thank you for supporting SWRM 2026." : "Your cart is still open."}</h1>
            <p>
              {isSuccess
                ? isMock
                  ? "Mock checkout mode confirmed the purchase path. Add a Stripe test secret key to create real Checkout Sessions."
                  : "Stripe has confirmed the checkout session. The SWRM team can follow up with logo, ad, and booth details."
                : "No payment was completed. Return to the portal when you are ready to continue."}
            </p>
            <a className="outline-button result-link" href={appBase}>
              Back to portal
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}
