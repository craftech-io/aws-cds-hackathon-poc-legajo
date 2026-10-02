import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Third-party runtime in chunks of its own (docs/landing-spec.md §5.3): the React runtime and the data
 * layer (zod, tRPC) change with a dependency bump, not with the app, so they cache apart and
 * `scripts/landing/bundle-budget.ts` measures them against their own cap, apart from the landing and
 * access code.
 */
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["vendor-react", /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/],
  ["vendor-data", /[\\/]node_modules[\\/](zod|@trpc[\\/](client|server))[\\/]/],
];

// Served from "/" behind the CloudFront Router (infra/web.ts); the BFF and the upload page live on
// the same origin under /api and /u.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0],
      },
    },
  },
});
