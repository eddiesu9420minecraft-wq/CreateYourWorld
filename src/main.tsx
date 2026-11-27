import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/noto-sans-tc/400.css";
import "@fontsource/noto-sans-tc/500.css";
import "@fontsource/noto-sans-tc/700.css";
import "./styles/theme.css";
import { SplashScreen } from "./pikara-splash";
import { App } from "./App";

const label = getCurrentWindow().label;
const root = ReactDOM.createRoot(document.getElementById("root")!);

root.render(
  <React.StrictMode>
    {label === "splash" ? (
      <SplashScreen productName="Create Your World." tagline="Free Forever." byline="— by pikara™" />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
