import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const API_PORT = Number(process.env.DEEPREAD_API_PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    // A fixed IPv4 address: "localhost" resolves to ::1 or 127.0.0.1 depending on the OS, and the phone tunnel
    // must know which one to reach.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // `pnpm phone` serves this dev server on a random *.trycloudflare.com name for reading on a phone.
    // The API still refuses those devices until they unlock with DEEPREAD_REMOTE_KEY.
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": `http://127.0.0.1:${API_PORT}`,
    },
  },
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
