import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// packages/chat-ui has no node_modules of its own; resolve its imports here.
const shared = [
  "react",
  "react-dom",
  "react-markdown",
  "remark-gfm",
  "remark-math",
  "rehype-katex",
  "katex",
  "@heroui/react",
  "@phosphor-icons/react",
];
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: Object.fromEntries(
      shared.map((name) => [name, path.resolve("node_modules", name)]),
    ),
  },
  server: { port: 5173, strictPort: true },
});
