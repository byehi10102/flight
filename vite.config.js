import { defineConfig } from "vite";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [cesium()],
  server: { port: 5173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
});
