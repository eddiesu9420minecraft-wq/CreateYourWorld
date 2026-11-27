import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `splash::SplashSnapshot` on the Rust side. */
export interface SplashSnapshot {
  step: number;
  total: number;
  message: string;
  backendDone: boolean;
  frontendReady: boolean;
  complete: boolean;
  warning: string | null;
}

export const splashBridge = {
  status: () => invoke<SplashSnapshot>("splash_status"),
  /** Splash page painted: the backend may now show the (still hidden) splash window. */
  shown: () => invoke<void>("splash_shown"),
  revealMain: () => invoke<void>("splash_reveal_main"),
  close: () => invoke<void>("splash_close"),
  /** Main window fully rendered with its initial data. */
  mainReady: () => invoke<void>("main_ready"),
  /** Resolves once backend initialization finished. */
  waitReady: () => invoke<void>("wait_ready"),
  onStatus: (cb: (s: SplashSnapshot) => void): Promise<UnlistenFn> =>
    listen<SplashSnapshot>("splash://status", (e) => cb(e.payload)),
  onComplete: (cb: () => void): Promise<UnlistenFn> => listen("splash://complete", () => cb()),
  onReveal: (cb: () => void): Promise<UnlistenFn> => listen("splash://reveal", () => cb()),
};
