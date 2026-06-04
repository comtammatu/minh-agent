import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  root: path.resolve(rootDir),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: path.resolve(rootDir, "./src/vitest.setup.ts"),
    globals: true,
    include: ["src/**/*.browser.tsx"],
  },
});
