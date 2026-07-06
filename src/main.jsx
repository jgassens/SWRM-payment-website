import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// GitHub Pages cannot send X-Frame-Options, and frame-ancestors is ignored in a <meta> CSP,
// so break out of framing to keep the admin surface (password field + destructive actions)
// from being clickjacked. Scoped to the admin route only, so the public storefront can still
// be embedded (e.g. inside the conference's own site).
const adminParams = new URLSearchParams(window.location.search);
const isAdminSurface =
  window.location.pathname.endsWith("/admin") || adminParams.get("admin") === "1";
if (isAdminSurface && window.top !== window.self) {
  try {
    window.top.location = window.location.href;
  } catch {
    document.documentElement.style.display = "none";
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
