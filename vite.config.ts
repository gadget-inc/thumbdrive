import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      path: "path-browserify",
    },
  },
  test: {
    setupFiles: ["@vitest/web-worker"],
    include: ["spec/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/e2e/**"],
  },
});
