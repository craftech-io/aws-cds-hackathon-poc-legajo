import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { SessionProvider } from "./context/SessionContext";
import "./index.css";
import { RouterProvider } from "./lib/router";
import { captureAttribution } from "./views/landing/utm";

// Where the visit came from (`utm_*`, the referrer's host), kept for the sign-up on any first route
// (ADR-0015 §2): no cookies, no analytics.
captureAttribution();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <RouterProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </RouterProvider>
  </StrictMode>,
);
