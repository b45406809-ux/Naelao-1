import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    // The Canvas host intentionally omits allow-same-origin. Vite module scripts
    // therefore need a local-development CORS response for the opaque frame.
    cors: { origin: "*" },
  },
});
