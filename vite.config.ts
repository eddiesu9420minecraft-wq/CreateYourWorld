import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Shared Pikara splash package (single source of truth for all Pikara apps).
    alias: { "@pikara/splash": fileURLToPath(new URL("./crates/pikara-splash/web/src/react.tsx", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      // splash.html is a tiny page of its own: it paints without loading React or the app bundle.
      input: { main: "index.html", splash: "splash.html" },
    },
  },
});
