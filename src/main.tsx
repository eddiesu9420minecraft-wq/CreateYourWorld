import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/noto-sans-tc/400.css";
import "@fontsource/noto-sans-tc/500.css";
import "@fontsource/noto-sans-tc/700.css";
import "./styles/theme.css";
import "./styles/motion.css";
import "./styles/feedback.css";
import "../crates/pikara-splash/web/splash.css";
import { App } from "./App";

// The splash window has its own page (splash.html → splash-main.ts); this is the main window.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
