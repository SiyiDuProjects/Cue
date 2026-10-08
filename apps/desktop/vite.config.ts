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
const modules = path.resolve("node_modules");
// `vite build` makes the Windows window (index.html). `--mode mac` makes the
// Mac answer view (content.html), loaded by the native window as one script.
export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      ...shared.map((name) => ({
        find: new RegExp(`^${name}(/.*)?$`),
        replacement: path.join(modules, name) + "$1",
      })),
      {
        find: /^@heroui-pro\/react\/([\w-]+)$/,
        replacement: path.join(
          modules,
          "@heroui-pro/react/dist/components/$1/index.js",
        ),
      },
      // Fixed grammars instead of shiki's on-demand imports; see src/shiki.ts.
      { find: /^shiki$/, replacement: path.resolve("src/shiki.ts") },
    ],
  },
  build:
    mode === "mac"
      ? {
          outDir: "dist-mac",
          rollupOptions: { input: path.resolve("content.html") },
        }
      : {},
  server: { port: 5173, strictPort: true },
}));
