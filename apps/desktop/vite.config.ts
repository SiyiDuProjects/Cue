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
// `--mode web` makes the cloud site's page (web.html) into the private cloud
// repository, which serves every file under /app/ as text: assets are inlined.
export default defineConfig(({ mode }) => ({
  base: mode === "web" ? "/app/" : "./",
  plugins: [
    react(),
    tailwindcss(),
    // Inlined fonts: every browser the page supports reads WOFF2, so the
    // WOFF and TrueType copies of KaTeX's fonts would only add weight.
    mode === "web" && {
      name: "woff2-only",
      enforce: "post" as const,
      generateBundle(_: unknown, bundle: Record<string, any>) {
        for (const file of Object.values(bundle))
          if (file.type === "asset" && file.fileName.endsWith(".css"))
            file.source = String(file.source).replace(
              /,url\(["']?data:[^)]+\)\s*format\(["']?(?:woff|truetype)["']?\)/g,
              "",
            );
      },
    },
  ],
  publicDir: mode === "web" ? false : "public",
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
      : mode === "web"
        ? {
            outDir: path.resolve("../cloud/web/app"),
            emptyOutDir: true,
            assetsInlineLimit: () => true,
            rollupOptions: {
              input: path.resolve("web.html"),
              output: {
                entryFileNames: "assets/web-[hash].js",
                chunkFileNames: "assets/web-[name]-[hash].js",
                assetFileNames: "assets/web-[hash][extname]",
              },
            },
          }
        : {},
  server: { port: 5173, strictPort: true },
}));
