// Entry of splash.html — the splash window. Deliberately tiny: no React, no app bundle.
import "@fontsource/noto-sans-tc/400.css";
import "@fontsource/noto-sans-tc/500.css";
import "@fontsource/noto-sans-tc/700.css";
import "../crates/pikara-splash/web/splash.css";
import { mountSplash } from "../crates/pikara-splash/web/src/pikara-splash";
import { transport } from "./splash";

mountSplash(document.getElementById("root")!, {
  productName: "Create Your World.",
  tagline: "Free Forever.",
  byline: "— by pikara™",
  transport,
});
