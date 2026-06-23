import React, { useEffect, useMemo, useState } from "react";
import AdminApp from "./Admin.jsx";
import { apiUrl, checkoutEndpoint, readJson } from "./api.js";
import { categories, formatCurrency, packages as fallbackPackages, withInventoryDefaults } from "./catalog.js";

const appBase = import.meta.env.BASE_URL || "/";
const logoUrl = `${appBase}assets/swrm-logo.webp`;
const noBoothChoiceId = "no-booth";
const menuCategoryIds = ["tiers", "programming", "digital", "meals", "branded", "student"];
const recommendedPackageIds = [
  "meals-coffee-break",
  "branded-lanyards",
  "meals-opening-reception",
  "student-poster-prize",
  "digital-wifi",
  "branded-full-ad"
];

const initialVendor = {
  organization: "",
  contactName: "",
  email: "",
  phone: "",
  website: "",
  notes: ""
};

export default function App() {
  const currentRoute = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const checkoutResult = params.get("checkout");

  if (currentRoute.endsWith("/admin") || params.get("admin") === "1") {
    return <AdminApp appBase={appBase} Header={ConferenceHeader} />;
  }

  if (checkoutResult === "success" || currentRoute.endsWith("/success")) {
    return <CheckoutResult status="success" />;
  }

  if (checkoutResult === "cancel" || currentRoute.endsWith("/cancel")) {
    return <CheckoutResult status="cancel" />;
  }

  return <Storefront />;
}

function Storefront() {
  const [activeCategory, setActiveCategory] = useState("recommended");
  const [selectedBoothPath, setSelectedBoothPath] = useState(null);
  const [catalog, setCatalog] = useState(() => fallbackPackages.map(withInventoryDefaults));
  const [catalogState, setCatalogState] = useState({ status: "loading", message: "" });
  const [cart, setCart] = useState([]);
  const [vendor, setVendor] = useState(initialVendor);
  const [checkoutState, setCheckoutState] = useState({ status: "idle", message: "" });

  useEffect(() => {
    let canceled = false;

    async function loadCatalog() {
      try {
        const data = await readJson(await fetch(apiUrl("/api/catalog")));
        if (canceled) return;
        setCatalog(data.packages.map(normalizePackage));
        setCatalogState({ status: "ready", message: "" });
      } catch (error) {
        if (canceled) return;
        setCatalogState({
          status: "fallback",
          message: "Live inventory is temporarily unavailable; showing the prospectus catalog."
        });
      }
    }

    loadCatalog();
    return () => {
      canceled = true;
    };
  }, []);

  const catalogById = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const boothPackages = useMemo(
    () => catalog.filter((item) => item.category === "booths" && item.active !== false),
    [catalog]
  );
  const menuCategories = useMemo(
    () => [
      { id: "recommended", label: "Recommended" },
      ...categories.filter((category) => menuCategoryIds.includes(category.id))
    ],
    []
  );
  const visiblePackages = useMemo(
    () => {
      const activePackages = catalog.filter((item) => item.active !== false);
      if (activeCategory === "recommended") {
        const recommended = recommendedPackageIds
          .map((id) => activePackages.find((item) => item.id === id))
          .filter(Boolean);
        return recommended.length > 0
          ? recommended
          : activePackages.filter((item) => menuCategoryIds.includes(item.category)).slice(0, 6);
      }
      return activePackages.filter((item) => item.category === activeCategory);
    },
    [activeCategory, catalog]
  );
  const cartLines = useMemo(
    () =>
      cart
        .map((line) => {
          const item = catalogById.get(line.id);
          return item ? { ...line, item } : null;
        })
        .filter(Boolean),
    [cart, catalogById]
  );
  const selectedBoothItem =
    selectedBoothPath && selectedBoothPath !== noBoothChoiceId
      ? catalogById.get(selectedBoothPath)
      : null;
  const hasBoothPath = Boolean(selectedBoothPath);
  const total = cartLines.reduce((sum, line) => sum + line.item.price * line.quantity, 0);
  const cartCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);

  function addToCart(itemId, options = {}) {
    const item = catalogById.get(itemId);
    if (!item || isSoldOut(item)) return;

    setCart((lines) => {
      const scopedLines = options.replaceBooth
        ? lines.filter((line) => catalogById.get(line.id)?.category !== "booths")
        : lines;
      const existing = scopedLines.find((line) => line.id === itemId);
      const maxQuantity = maxQuantityFor(item);
      if (existing) {
        return scopedLines.map((line) =>
          line.id === itemId
            ? { ...line, quantity: Math.min(maxQuantity, line.quantity + 1) }
            : line
        );
      }
      return [...scopedLines, { id: itemId, quantity: 1 }];
    });
  }

  function chooseBoothPath(choiceId) {
    setSelectedBoothPath(choiceId);
    if (choiceId === noBoothChoiceId) {
      setCart((lines) => lines.filter((line) => catalogById.get(line.id)?.category !== "booths"));
      scrollToSponsorMenu();
      return;
    }
    addToCart(choiceId, { replaceBooth: true });
    scrollToSponsorMenu();
  }

  function scrollToSponsorMenu() {
    window.requestAnimationFrame(() => {
      document.getElementById("sponsorship-menu")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function updateQuantity(itemId, change) {
    const item = catalogById.get(itemId);
    const maxQuantity = item ? maxQuantityFor(item) : 99;
    const nextLines = cart
      .map((line) =>
        line.id === itemId
          ? { ...line, quantity: Math.max(0, Math.min(maxQuantity, line.quantity + change)) }
          : line
      )
      .filter((line) => line.quantity > 0);

    setCart(nextLines);
    if (selectedBoothPath === itemId && !nextLines.some((line) => line.id === itemId)) {
      setSelectedBoothPath(noBoothChoiceId);
    }
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
      const data = await readJson(response);
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
      <ConferenceHeader cartCount={cartCount} />
      <main className="page">
        <IntroBlock />

        <section className="commerce-grid" aria-label="SWRM sponsorship checkout">
          <div className="catalog-column">
            <BoothPathStep
              boothPackages={boothPackages}
              selectedBoothPath={selectedBoothPath}
              onChoose={chooseBoothPath}
            />

            <section
              id="sponsorship-menu"
              className={hasBoothPath ? "addon-menu" : "addon-menu locked"}
              aria-label="Sponsorship add-on menu"
            >
              <div className="section-heading">
                <div>
                  <p className="section-label">Step 2: build brand awareness</p>
                  <h2>Add sponsorship moments across the meeting</h2>
                </div>
                <p className="deadline-note">
                  Support ACS programming while putting your logo in the attendee path.
                </p>
              </div>

              <div className="addon-pitch">
                <strong>High-traffic options make the booth choice work harder.</strong>
                <span>
                  Coffee breaks, lanyards, speaker sessions, ads, and student awards turn
                  simple vendor registration into visible support for the chemistry community.
                </span>
              </div>

              <CategoryTabs
                activeCategory={activeCategory}
                onChange={setActiveCategory}
                categoriesToShow={menuCategories}
                disabled={!hasBoothPath}
              />

              {catalogState.message ? <p className="checkout-note">{catalogState.message}</p> : null}

              {!hasBoothPath ? (
                <div className="locked-callout">
                  Choose a booth path above to open the sponsorship menu. The recommended
                  add-ons are already visible here so vendors see the brand-building options
                  before checkout.
                </div>
              ) : null}

              <div className="package-grid">
                {visiblePackages.map((item) => (
                  <PackageCard
                    key={item.id}
                    item={item}
                    onAdd={addToCart}
                    disabled={!hasBoothPath}
                  />
                ))}
              </div>
            </section>
          </div>

          <CartPanel
            vendor={vendor}
            onVendorChange={updateVendor}
            cartLines={cartLines}
            total={total}
            onQuantityChange={updateQuantity}
            onCheckout={startCheckout}
            checkoutState={checkoutState}
            hasBoothPath={hasBoothPath}
            selectedBoothPath={selectedBoothPath}
            selectedBoothItem={selectedBoothItem}
          />
        </section>

        <Deadlines />
      </main>
    </div>
  );
}

function ConferenceHeader({ cartCount, admin = false }) {
  return (
    <header>
      <div className="announcement">
        SWRM 2026 will be at Hilton Fort Worth, Nov 16-19
      </div>
      <div className="masthead">
        <nav className="masthead-inner" aria-label="Primary">
          <a href={admin ? appBase : "#packages"} className="menu-link">
            {admin ? "Storefront" : "Packages"}
          </a>
          <img
            className="conference-logo"
            src={logoUrl}
            alt="SWRM 2026 Chemistry at the Intersection of Energy, Sustainability and Biology"
          />
          <a href={admin ? `${appBase}?admin=1` : "#checkout"} className="menu-link cart-link">
            {admin ? "Admin" : `Cart (${cartCount})`}
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
          Start with your exhibit footprint, then add high-visibility sponsorship moments
          that support ACS programming and keep your brand in front of regional chemists
          throughout the November 16-19 meeting in downtown Fort Worth.
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

function BoothPathStep({ boothPackages, selectedBoothPath, onChoose }) {
  const noBoothChoice = {
    id: noBoothChoiceId,
    name: "No booth, just logo visibility and sponsorship add-ons",
    price: 0,
    availability: "sponsorship only",
    summary:
      "Skip exhibit space and support SWRM through coffee breaks, branded items, ads, student awards, or other recognition.",
    included: [
      "Best for remote vendors, institutions, and community supporters",
      "Opens the same add-on sponsorship menu"
    ]
  };
  const choices = [...boothPackages, noBoothChoice];

  return (
    <section className="booth-step" aria-label="Choose a booth path">
      <div className="section-heading">
        <div>
          <p className="section-label">Step 1: booth path</p>
          <h2>Start with your exhibit footprint</h2>
        </div>
        <p className="deadline-note">
          Booth sales and logo materials are due September 15, 2026.
        </p>
      </div>

      <div className="booth-options-grid">
        {choices.map((item) => {
          const selected = selectedBoothPath === item.id;
          const soldOut = item.id !== noBoothChoiceId && isSoldOut(item);

          return (
            <button
              key={item.id}
              type="button"
              className={selected ? "booth-card selected" : "booth-card"}
              onClick={() => onChoose(item.id)}
              disabled={soldOut}
              aria-pressed={selected}
            >
              <span className="card-topline">
                <span>{item.id === noBoothChoiceId ? item.availability : inventoryLabel(item)}</span>
                <span>{item.price === 0 ? "No booth" : formatCurrency(item.price)}</span>
              </span>
              <span className="booth-card-title">{item.name}</span>
              {item.label ? <span className="item-label">{item.label}</span> : null}
              <span className="summary">{item.summary}</span>
              <span className="booth-benefits">
                {item.included.slice(0, 2).map((benefit) => (
                  <span key={benefit}>{benefit}</span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CategoryTabs({ activeCategory, onChange, categoriesToShow = categories, disabled = false }) {
  return (
    <div id="packages" className="category-tabs" role="tablist" aria-label="Package categories">
      {categoriesToShow.map((category) => (
        <button
          key={category.id}
          className={category.id === activeCategory ? "tab active" : "tab"}
          type="button"
          role="tab"
          aria-selected={category.id === activeCategory}
          disabled={disabled}
          onClick={() => onChange(category.id)}
        >
          {category.label}
        </button>
      ))}
    </div>
  );
}

function PackageCard({ item, onAdd, disabled = false }) {
  const soldOut = isSoldOut(item);
  const cannotAdd = disabled || soldOut;

  return (
    <article
      className={cannotAdd ? "package-card sold-out" : "package-card"}
      data-testid={`package-${item.id}`}
    >
      <div className="card-topline">
        <span>{inventoryLabel(item)}</span>
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
        disabled={cannotAdd}
      >
        {soldOut ? "Sold out" : disabled ? "Pick booth path" : "Add"}
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
  checkoutState,
  hasBoothPath,
  selectedBoothPath,
  selectedBoothItem
}) {
  const cartItemCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const canCheckout =
    hasBoothPath &&
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

      <div className="booth-summary">
        <span>Booth path</span>
        <strong>
          {selectedBoothPath === noBoothChoiceId
            ? "No booth, sponsorship add-ons only"
            : selectedBoothItem?.name || "Choose booth path first"}
        </strong>
      </div>

      <div className="cart-block">
        <div className="cart-heading">
          <h3>Cart</h3>
          <span>
            {cartItemCount} {cartItemCount === 1 ? "item" : "items"}
          </span>
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
      ) : !hasBoothPath ? (
        <p className="checkout-note">Choose a booth path before checkout opens.</p>
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

function normalizePackage(item) {
  return {
    ...item,
    price: Number(item.price || 0),
    priceCents: Number(item.priceCents || 0),
    included: Array.isArray(item.included) ? item.included : [],
    stockTotal: item.stockTotal === undefined ? null : item.stockTotal,
    stockRemaining: item.stockRemaining === undefined ? null : item.stockRemaining,
    active: item.active !== false
  };
}

function maxQuantityFor(item) {
  return Number.isInteger(item.stockRemaining) ? Math.max(0, item.stockRemaining) : 99;
}

function isSoldOut(item) {
  return item.active === false || item.stockRemaining === 0;
}

function inventoryLabel(item) {
  if (item.active === false) return "Hidden";
  if (item.stockRemaining === 0) return "Sold out";
  if (Number.isInteger(item.stockRemaining)) return `${item.stockRemaining} left`;
  return item.availability;
}
