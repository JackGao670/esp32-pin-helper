import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    outDir: "../dist/webview",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "planner.js",
        assetFileNames: asset => asset.name?.endsWith(".css") ? "planner.css" : "[name][extname]"
      }
    }
  }
});
