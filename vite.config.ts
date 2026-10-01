import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API_PORT = Number(process.env.DEEPREAD_API_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${API_PORT}`,
    },
  },
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
