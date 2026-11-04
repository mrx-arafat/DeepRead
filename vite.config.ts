/// <reference types="vitest/config" />
// Types only from vitest: a reader's install has no test tools, and `vite build` must still load this file.
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

const API_PORT = Number(process.env.DEEPREAD_API_PORT ?? 8787);

/**
 * Writes a brotli (.br) and a gzip (.gz) copy beside each script, stylesheet and page the build makes. The server sends
 * the smaller copy to a browser that takes it (server/app.ts), so the app arrives about a quarter of its size even
 * when no proxy in front compresses it. Done once here, at the strongest settings, rather than on every request.
 */
function precompress(): Plugin {
  return {
    name: "deepread:precompress",
    apply: "build",
    writeBundle(output, bundle) {
      for (const name of Object.keys(bundle)) {
        if (!/\.(js|css|html|svg)$/.test(name)) continue;
        const path = join(output.dir!, name);
        const data = readFileSync(path);
        const copies = {
          br: brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
          gz: gzipSync(data, { level: 9 }),
        };
        for (const [extension, copy] of Object.entries(copies)) if (copy.length < data.length) writeFileSync(`${path}.${extension}`, copy);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), precompress()],
  build: {
    rolldownOptions: {
      output: {
        // React in a file of its own: it changes only when React is upgraded, so after a DeepRead update a returning
        // reader's browser fetches the app's own code again (about a quarter of the first paint) and keeps React.
        codeSplitting: {
          groups: [{ name: "react", test: /node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
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
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        // If the server stops in the middle of a streamed answer, break the browser's connection too, as the
        // server itself would have. Left alone, the proxy holds it open and the half answer waits forever.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, _req, res) => {
            proxyRes.on("close", () => {
              if (!proxyRes.complete) res.destroy();
            });
          });
        },
      },
    },
  },
  test: {
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
