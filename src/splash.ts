// CYW's connection to the shared Pikara splash (crates/pikara-splash). CYW bundles @tauri-apps/api,
// so the package talks to Tauri through it instead of window.__TAURI__.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createBridge, type Transport } from "../crates/pikara-splash/web/src/pikara-splash";

export const transport: Transport = {
  invoke: <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args),
  listen: <T,>(event: string, cb: (payload: T) => void) => listen<T>(event, (e) => cb(e.payload)),
};

export const splashBridge = createBridge(transport);

/** Background of CYW's (dark-only) main window; the reveal overlay must match it. */
export const MAIN_BACKGROUND = "#121214";
