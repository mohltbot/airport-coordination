import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        cookieDomainRewrite: { "*": "" },
        // Vite streams proxy responses directly, including named SSE frames.
        // Preserve Origin: the API validates the browser origin and CSRF token.
      },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
