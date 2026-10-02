import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  ...(mode === "browser-preview" ? {
    build: { outDir: "dist-browser-preview", rollupOptions: { input: "browser-preview.html" } },
    preview: { proxy: {
      "/api": "http://127.0.0.1:8001",
      "/health": "http://127.0.0.1:8001",
      "/ws": { target: "ws://127.0.0.1:8001", ws: true },
    } },
  } : {}),
}));
