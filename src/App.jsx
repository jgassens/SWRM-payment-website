import React, { useEffect, useMemo, useState } from "react";
import AdminApp from "./Admin.jsx";
import {
  apiUrl,
  checkoutEndpoint,
  confirmCheckoutEndpoint,
  demoCheckoutEndpoint,
  readJson
} from "./api.js";
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
const demoInventoryStorageKey = "swrm-demo-inventory-v1";
const demoOrderStorageKey = "swrm-demo-last-order-v1";
const pendingDemoOrderStorageKey = "swrm-demo-pending-order-v1";
const demoOrdersStorageKey = "swrm-demo-orders-v1";
const completedDemoOrderIdsStorageKey = "swrm-demo-completed-order-ids-v1";
const forceDemoMode = true;
const requiredVendorFields = ["organization", "contactName", "email", "phone", "website"];

export default function App() {
  const currentRoute = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const checkoutResult = params.get("checkout");
  const isDemoMode = forceDemoMode || params.get("demo") === "1";

  if (currentRoute.endsWith("/admin") || params.get("admin") === "1") {
    return <AdminApp appBase={appBase} Header={ConferenceHeader} />;
  }

  if (checkoutResult === "success" || currentRoute.endsWith("/success")) {
    return <CheckoutResult status="success" isDemoMode={isDemoMode} />;
  }

  if (checkoutResult === "cancel" || currentRoute.endsWith("/cancel")) {
    return <CheckoutResult status="cancel" isDemoMode={isDemoMode} />;
  }

  return <Storefront isDemoMode={isDemoMode} />;
}

function Storefront({ isDemoMode }) {
  const [activeCategory, setActiveCategory] = useState("recommended");
  const [selectedBoothPath, setSelectedBoothPath] = useState(null);
  const [baseCatalog, setBaseCatalog] = useState(createInitialCatalog);
  const [demoInventory, setDemoInventory] = useState(() =>
    isDemoMode ? readStoredDemoInventory() : null
  );
  const [catalogState, setCatalogState] = useState({ status: "loading", message: "" });
  const [cart, setCart] = useState([]);
  const [vendor, setVendor] = useState(initialVendor);
  const [checkoutState, setCheckoutState] = useState({ status: "idle", message: "" });
  const catalog = useMemo(
    () => (isDemoMode ? applyDemoInventory(baseCatalog, demoInventory) : baseCatalog),
    [baseCatalog, demoInventory, isDemoMode]
  );

  useEffect(() => {
    if (!isDemoMode) {
      clearDemoSandbox();
      setDemoInventory(null);
    }
  }, [isDemoMode]);

  useEffect(() => {
    let canceled = false;

    async function loadCatalog() {
      try {
        const data = await readJson(await fetch(apiUrl("/api/catalog")));
        if (canceled) return;
        const nextCatalog = data.packages.map(normalizePackage);
        setBaseCatalog(nextCatalog);
        if (isDemoMode) {
          setDemoInventory(ensureStoredDemoInventory(nextCatalog));
        }
        setCatalogState({ status: "ready", message: "" });
      } catch (error) {
        if (canceled) return;
        if (isDemoMode) {
          setDemoInventory(ensureStoredDemoInventory(createInitialCatalog()));
        }
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
  }, [isDemoMode]);

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

  function resetDemoInventory() {
    const nextInventory = createDemoInventory(baseCatalog);
    writeStoredDemoInventory(nextInventory);
    clearStoredDemoOrder();
    setDemoInventory(nextInventory);
    setCart([]);
    setSelectedBoothPath(null);
    setCheckoutState({
      status: "idle",
      message: "Demo inventory reset from the current live catalog."
    });
  }

  async function startCheckout() {
    if (isDemoMode) {
      setCheckoutState({ status: "loading", message: "Opening Stripe test Checkout..." });

      try {
        const currentInventory = ensureDemoInventory(
          baseCatalog,
          demoInventory || readStoredDemoInventory()
        );
        reserveDemoInventory(currentInventory, cartLines);
        const demoOrder = createDemoOrder({ cartLines, total, vendor });
        writePendingDemoOrder(demoOrder);

        const response = await fetch(demoCheckoutEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cart, vendor, demoOrderId: demoOrder.id })
        });
        const data = await readJson(response);

        if (!data.url) {
          throw new Error("Stripe did not return a demo Checkout URL.");
        }

        window.location.href = data.url;
      } catch (error) {
        clearPendingDemoOrder();
        setCheckoutState({
          status: "error",
          message: error.message || "Demo checkout could not be completed."
        });
      }
      return;
    }

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
      <ConferenceHeader cartCount={cartCount} isDemoMode={isDemoMode} />
      <main className="page">
        <IntroBlock />
        <DemoModePanel
          isDemoMode={isDemoMode}
          onReset={resetDemoInventory}
        />

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
            isDemoMode={isDemoMode}
          />
        </section>

        <Deadlines />
      </main>
    </div>
  );
}

function ConferenceHeader({ cartCount, admin = false, isDemoMode = false }) {
  const packageHref = isDemoMode ? `${appBase}?demo=1#packages` : "#packages";
  const checkoutHref = isDemoMode ? `${appBase}?demo=1#checkout` : "#checkout";

  return (
    <header>
      <div className="announcement">
        SWRM 2026 will be at Hilton Fort Worth, Nov 16-19
      </div>
      <div className="masthead">
        <nav className="masthead-inner" aria-label="Primary">
          <a href={admin ? appBase : packageHref} className="menu-link">
            {admin ? "Storefront" : "Packages"}
          </a>
          <img
            className="conference-logo"
            src={logoUrl}
            alt="SWRM 2026 Chemistry at the Intersection of Energy, Sustainability and Biology"
          />
          <a href={admin ? `${appBase}?admin=1` : checkoutHref} className="menu-link cart-link">
            {admin ? "Admin" : `${isDemoMode ? "Demo cart" : "Cart"} (${cartCount})`}
          </a>
        </nav>
      </div>
    </header>
  );
}

function DemoModePanel({ isDemoMode, onReset }) {
  if (!isDemoMode) {
    return (
      <section className="demo-panel" aria-label="Demo checkout mode">
        <div>
          <p className="section-label">Demo mode</p>
          <strong>Test the full purchase flow without touching live payments or inventory.</strong>
          <span>
            Demo mode uses the current catalog, opens Stripe test checkout, and keeps inventory
            changes only in this browser until it is reset.
          </span>
        </div>
        <a className="outline-button demo-action" href={`${appBase}?demo=1`}>
          Try demo mode
        </a>
      </section>
    );
  }

  return (
    <section className="demo-panel active-demo" aria-label="Demo checkout mode is active">
      <div>
        <p className="section-label">Demo mode active</p>
        <strong>Checkout uses Stripe test mode; real payments and live inventory stay untouched.</strong>
        <span>
          This sandbox starts from the live catalog and reduces only temporary inventory in this
          browser after test checkout succeeds, so you can confirm the buying flow behaves like
          the real one.
        </span>
      </div>
      <div className="demo-actions">
        <button type="button" className="outline-button demo-action" onClick={onReset}>
          Reset demo
        </button>
      </div>
    </section>
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
  selectedBoothItem,
  isDemoMode = false
}) {
  const cartItemCount = cartLines.reduce((sum, line) => sum + line.quantity, 0);
  const canCheckout =
    hasBoothPath &&
    cartLines.length > 0 &&
    requiredVendorFields.every((field) => vendor[field].trim());

  return (
    <aside id="checkout" className="cart-panel" aria-label="Vendor registration and cart">
      <div className="cart-panel-header">
        <p className="section-label">Checkout</p>
        <h2>Vendor registration</h2>
      </div>

      <div className="form-grid">
        <label>
          Organization <span className="required-marker" aria-hidden="true">*</span>
          <input
            value={vendor.organization}
            onChange={(event) => onVendorChange("organization", event.target.value)}
            autoComplete="organization"
            required
          />
        </label>
        <label>
          Contact name <span className="required-marker" aria-hidden="true">*</span>
          <input
            value={vendor.contactName}
            onChange={(event) => onVendorChange("contactName", event.target.value)}
            autoComplete="name"
            required
          />
        </label>
        <label>
          Email <span className="required-marker" aria-hidden="true">*</span>
          <input
            value={vendor.email}
            onChange={(event) => onVendorChange("email", event.target.value)}
            autoComplete="email"
            type="email"
            required
          />
        </label>
        <label>
          Phone <span className="required-marker" aria-hidden="true">*</span>
          <input
            value={vendor.phone}
            onChange={(event) => onVendorChange("phone", event.target.value)}
            autoComplete="tel"
            type="tel"
            required
          />
        </label>
        <label className="span-all">
          Website <span className="required-marker" aria-hidden="true">*</span>
          <input
            value={vendor.website}
            onChange={(event) => onVendorChange("website", event.target.value)}
            autoComplete="url"
            inputMode="url"
            placeholder="https://"
            required
          />
        </label>
        <label className="span-all">
          Logo / follow-up notes
          <textarea
            value={vendor.notes}
            onChange={(event) => onVendorChange("notes", event.target.value)}
            placeholder="Optional: logo contact, PO notes, ad file timing, or sponsorship details"
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
        {checkoutState.status === "loading"
          ? isDemoMode
            ? "Opening test checkout..."
            : "Creating checkout..."
          : isDemoMode
            ? "Run demo checkout"
            : "Proceed to checkout"}
      </button>

      {checkoutState.message ? (
        <p className={checkoutState.status === "error" ? "checkout-error" : "checkout-note"}>
          {checkoutState.message}
        </p>
      ) : !hasBoothPath ? (
        <p className="checkout-note">Choose a booth path before checkout opens.</p>
      ) : isDemoMode ? (
        <p className="checkout-note">
          Demo checkout opens Stripe test mode, captures vendor registration, and adjusts only
          this browser's temporary inventory after the test payment succeeds.
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

function CheckoutResult({ status, isDemoMode = false }) {
  const params = new URLSearchParams(window.location.search);
  const isMock = params.get("mock") === "1";
  const isDemoCheckout = isDemoMode || isMock;
  const isSuccess = status === "success";
  const stripeSessionId = params.get("session_id") || "";
  const [demoOrder, setDemoOrder] = useState(() =>
    isDemoCheckout ? readStoredDemoOrder() || readPendingDemoOrder() : null
  );
  const [purchaseRecordState, setPurchaseRecordState] = useState({
    status: isSuccess && !isDemoCheckout ? "loading" : "idle",
    message: ""
  });

  useEffect(() => {
    if (!isDemoCheckout) return;
    if (!isSuccess) {
      clearPendingDemoOrder();
      return;
    }
    const finalizedOrder = finalizeDemoCheckout();
    if (finalizedOrder) setDemoOrder(finalizedOrder);
  }, [isSuccess, isDemoCheckout]);

  useEffect(() => {
    if (!isSuccess || isDemoCheckout) return;

    if (!stripeSessionId) {
      setPurchaseRecordState({
        status: "error",
        message: "Stripe did not return a session id on this success page."
      });
      return;
    }

    let canceled = false;

    async function confirmPurchaseRecord() {
      try {
        const response = await fetch(confirmCheckoutEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: stripeSessionId })
        });
        const data = await readJson(response);
        if (canceled) return;

        setPurchaseRecordState({
          status: data.recorded ? "success" : "pending",
          message: data.recorded
            ? `SWRM order book marked paid from Stripe session ${data.sessionId}.`
            : data.paid
              ? `Stripe says this payment is ${data.paymentStatus || "paid"}, but it was not matched to an SWRM order record.`
              : `Stripe session ${data.sessionId} is ${data.paymentStatus || data.status || "pending"}; the order book will update when payment completes.`
        });
      } catch (error) {
        if (canceled) return;
        setPurchaseRecordState({
          status: "error",
          message: error.message || "Stripe confirmation could not update the SWRM order book."
        });
      }
    }

    confirmPurchaseRecord();
    return () => {
      canceled = true;
    };
  }, [isSuccess, isDemoCheckout, stripeSessionId]);

  function resetDemoAndReturn() {
    clearDemoSandbox();
    window.location.href = `${appBase}?demo=1`;
  }

  return (
    <div className="app-shell result-shell">
      <ConferenceHeader cartCount={0} isDemoMode={isDemoCheckout} />
      <main className="page">
        <section className="intro-panel result-panel">
          <div className="accent-rule" aria-hidden="true" />
          <div className="intro-copy">
            <p className="section-label">
              {isSuccess
                ? isDemoCheckout
                  ? "Demo checkout complete"
                  : "Checkout complete"
                : "Checkout canceled"}
            </p>
            <h1>
              {isSuccess
                ? isDemoCheckout
                  ? "Demo checkout ran like the real flow."
                  : "Thank you for supporting SWRM 2026."
                : "Your cart is still open."}
            </h1>
            <p>
              {isSuccess
                ? isDemoCheckout
                  ? "Stripe test checkout completed. Real SWRM inventory was not changed; this browser's demo inventory and vendor registration sandbox were updated so you can verify the full purchase path."
                  : "Stripe has confirmed the checkout session. The SWRM team can follow up with logo, ad, and booth details."
                : "No payment was completed. Return to the portal when you are ready to continue."}
            </p>
            {isSuccess && isDemoCheckout && demoOrder ? (
              <div className="demo-confirmation-grid">
                <div className="demo-receipt" aria-label="Demo order summary">
                  <span>Demo order {demoOrder.id}</span>
                  <strong>{formatCurrency(demoOrder.total)}</strong>
                  <span>{demoOrder.itemCount} sponsorship item(s) simulated</span>
                  <span>
                    {demoOrder.completedAt ? "Demo order book updated" : "Finalizing demo order book"}
                  </span>
                </div>
                <div className="demo-registration" aria-label="Demo vendor registration summary">
                  <span>Vendor registration captured</span>
                  <strong>{demoOrder.vendor.organization}</strong>
                  <dl>
                    <div>
                      <dt>Contact</dt>
                      <dd>{demoOrder.vendor.contactName}</dd>
                    </div>
                    <div>
                      <dt>Email</dt>
                      <dd>{demoOrder.vendor.email}</dd>
                    </div>
                    <div>
                      <dt>Phone</dt>
                      <dd>{demoOrder.vendor.phone || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Website</dt>
                      <dd>{demoOrder.vendor.website || "Not provided"}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            ) : null}
            {isSuccess && !isDemoCheckout ? (
              <p
                className={
                  purchaseRecordState.status === "error" ? "checkout-error" : "checkout-note"
                }
              >
                {purchaseRecordState.message || "Confirming Stripe purchase record..."}
              </p>
            ) : null}
            <div className="result-actions">
              <a className="outline-button result-link" href={isDemoCheckout ? `${appBase}?demo=1` : appBase}>
                {isDemoCheckout ? "Back to demo portal" : "Back to portal"}
              </a>
              {isDemoCheckout ? (
                <button type="button" className="outline-button result-link" onClick={resetDemoAndReturn}>
                  Reset demo
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function createInitialCatalog() {
  return fallbackPackages.map((item, index) => normalizePackage(withInventoryDefaults(item, index)));
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

function applyDemoInventory(catalog, inventory) {
  if (!inventory?.items) return catalog;
  return catalog.map((item) => {
    const demoItem = inventory.items[item.id];
    if (!demoItem) return item;
    return {
      ...item,
      stockTotal: demoItem.stockTotal,
      stockRemaining: demoItem.stockRemaining
    };
  });
}

function ensureStoredDemoInventory(catalog) {
  const nextInventory = ensureDemoInventory(catalog, readStoredDemoInventory());
  writeStoredDemoInventory(nextInventory);
  return nextInventory;
}

function ensureDemoInventory(catalog, currentInventory) {
  const safeInventory = currentInventory?.items ? currentInventory : createDemoInventory([]);
  const items = { ...safeInventory.items };

  catalog.forEach((item) => {
    if (!items[item.id]) {
      items[item.id] = inventoryRecordFromItem(item);
    }
  });

  return {
    version: 1,
    seededAt: safeInventory.seededAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items
  };
}

function createDemoInventory(catalog) {
  return {
    version: 1,
    seededAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    items: Object.fromEntries(catalog.map((item) => [item.id, inventoryRecordFromItem(item)]))
  };
}

function inventoryRecordFromItem(item) {
  return {
    stockTotal: Number.isInteger(item.stockTotal) ? item.stockTotal : null,
    stockRemaining: Number.isInteger(item.stockRemaining) ? item.stockRemaining : null
  };
}

function reserveDemoInventory(inventory, cartLines) {
  const items = { ...inventory.items };

  cartLines.forEach((line) => {
    const current = items[line.id] || inventoryRecordFromItem(line.item);
    if (!Number.isInteger(current.stockRemaining)) {
      items[line.id] = current;
      return;
    }

    if (current.stockRemaining < line.quantity) {
      throw new Error(`${line.item.name} no longer has enough demo inventory.`);
    }

    items[line.id] = {
      ...current,
      stockRemaining: current.stockRemaining - line.quantity
    };
  });

  return {
    ...inventory,
    updatedAt: new Date().toISOString(),
    items
  };
}

function createDemoOrder({ cartLines, total, vendor }) {
  return {
    id: `demo_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    vendor: {
      organization: cleanDemoValue(vendor.organization),
      contactName: cleanDemoValue(vendor.contactName),
      email: cleanDemoValue(vendor.email),
      phone: cleanDemoValue(vendor.phone),
      website: cleanDemoValue(vendor.website),
      notes: cleanDemoValue(vendor.notes)
    },
    itemCount: cartLines.reduce((sum, line) => sum + line.quantity, 0),
    total,
    items: cartLines.map((line) => ({
      id: line.id,
      name: line.item.name,
      quantity: line.quantity,
      price: line.item.price
    }))
  };
}

function cleanDemoValue(value) {
  return String(value || "").trim();
}

function readStoredDemoInventory() {
  try {
    const rawValue = window.localStorage.getItem(demoInventoryStorageKey);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch (error) {
    return null;
  }
}

function writeStoredDemoInventory(inventory) {
  try {
    window.localStorage.setItem(demoInventoryStorageKey, JSON.stringify(inventory));
  } catch (error) {
    // Demo mode can still run with in-memory inventory if storage is unavailable.
  }
}

function writeStoredDemoOrder(order) {
  try {
    window.sessionStorage.setItem(demoOrderStorageKey, JSON.stringify(order));
  } catch (error) {
    // Receipt details are nice-to-have; checkout state remains visible without them.
  }
  appendStoredDemoOrder(order);
}

function writePendingDemoOrder(order) {
  try {
    window.sessionStorage.setItem(pendingDemoOrderStorageKey, JSON.stringify(order));
  } catch (error) {
    // Pending order data is recovered from the cart before redirect when storage is available.
  }
}

function readStoredDemoOrder() {
  try {
    const rawValue = window.sessionStorage.getItem(demoOrderStorageKey);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch (error) {
    return null;
  }
}

function readPendingDemoOrder() {
  try {
    const rawValue = window.sessionStorage.getItem(pendingDemoOrderStorageKey);
    return rawValue ? JSON.parse(rawValue) : null;
  } catch (error) {
    return null;
  }
}

function clearPendingDemoOrder() {
  try {
    window.sessionStorage.removeItem(pendingDemoOrderStorageKey);
  } catch (error) {
    // Ignore storage failures during demo cleanup.
  }
}

function clearStoredDemoOrder() {
  try {
    window.sessionStorage.removeItem(demoOrderStorageKey);
  } catch (error) {
    // Ignore storage failures during demo cleanup.
  }
  clearPendingDemoOrder();
  try {
    window.localStorage.removeItem(demoOrdersStorageKey);
  } catch (error) {
    // Ignore storage failures during demo cleanup.
  }
  try {
    window.localStorage.removeItem(completedDemoOrderIdsStorageKey);
  } catch (error) {
    // Ignore storage failures during demo cleanup.
  }
}

function appendStoredDemoOrder(order) {
  try {
    const rawValue = window.localStorage.getItem(demoOrdersStorageKey);
    const current = rawValue ? JSON.parse(rawValue) : [];
    const orders = Array.isArray(current) ? current : [];
    const nextOrders = [order, ...orders.filter((item) => item?.id !== order.id)].slice(0, 50);
    window.localStorage.setItem(demoOrdersStorageKey, JSON.stringify(nextOrders));
  } catch (error) {
    // Demo order history is only for local verification.
  }
}

function finalizeDemoCheckout() {
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get("demo_order") || "";
  const stripeSessionId = params.get("session_id") || "";
  const pendingOrder = readPendingDemoOrder();
  const storedOrder = readStoredDemoOrder();
  const order =
    pendingOrder && (!orderId || pendingOrder.id === orderId)
      ? pendingOrder
      : storedOrder && (!orderId || storedOrder.id === orderId)
        ? storedOrder
        : null;

  if (!order?.id) return null;
  if (isCompletedDemoOrder(order.id)) return storedOrder || order;

  const completedOrder = {
    ...order,
    status: "demo",
    stripeDemo: true,
    stripeSessionId,
    paymentStatus: stripeSessionId ? "paid" : "simulated",
    completedAt: new Date().toISOString()
  };

  try {
    const currentInventory = ensureDemoInventory(createInitialCatalog(), readStoredDemoInventory());
    const nextInventory = reserveDemoInventory(currentInventory, demoOrderToCartLines(order));
    writeStoredDemoInventory(nextInventory);
  } catch (error) {
    // The demo receipt/order book should still prove vendor capture if local inventory storage fails.
  }

  markCompletedDemoOrder(order.id);
  writeStoredDemoOrder(completedOrder);
  clearPendingDemoOrder();
  return completedOrder;
}

function demoOrderToCartLines(order) {
  return (Array.isArray(order.items) ? order.items : []).map((item) => ({
    id: item.id,
    quantity: Math.max(1, Number(item.quantity) || 1),
    item: {
      id: item.id,
      name: item.name || "Demo sponsorship item",
      stockTotal: null,
      stockRemaining: null
    }
  }));
}

function isCompletedDemoOrder(orderId) {
  return readCompletedDemoOrderIds().has(orderId);
}

function markCompletedDemoOrder(orderId) {
  const ids = readCompletedDemoOrderIds();
  ids.add(orderId);
  try {
    window.localStorage.setItem(completedDemoOrderIdsStorageKey, JSON.stringify(Array.from(ids).slice(-100)));
  } catch (error) {
    // Demo completion tracking is only used to prevent duplicate local inventory updates.
  }
}

function readCompletedDemoOrderIds() {
  try {
    const rawValue = window.localStorage.getItem(completedDemoOrderIdsStorageKey);
    const parsed = rawValue ? JSON.parse(rawValue) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch (error) {
    return new Set();
  }
}

function clearDemoSandbox() {
  try {
    window.localStorage.removeItem(demoInventoryStorageKey);
  } catch (error) {
    // Ignore storage failures during demo cleanup.
  }
  clearStoredDemoOrder();
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
