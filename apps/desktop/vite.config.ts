import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"], alias: Object.fromEntries(["react","react-dom","react-markdown","remark-gfm","remark-math","rehype-katex","katex"].map(name=>[name,path.resolve("node_modules",name)])) },
  server: { port: 5173, strictPort: true },
});
