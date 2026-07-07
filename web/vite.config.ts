import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Vite config for the Glassray Coach SPA — builds to dist/, proxies /api + /v1 to the local Fastify server in dev. */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:5899",
      // So an exporter can point at the dev port and still reach ingest.
      "/v1": "http://127.0.0.1:5899",
    },
  },
});
