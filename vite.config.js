import { defineConfig } from "vite";
import fs from "node:fs";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [
    cesium(),
    {
      // The multiplayer feature is self-contained raw files in multiplayer/
      // (root, NOT public/) loaded at runtime via a guarded dynamic import,
      // so deleting the folder removes the feature and the game falls back
      // to single player. Dev serves the folder directly; the build copies
      // it to dist/multiplayer/ verbatim.
      name: "copy-multiplayer",
      apply: "build",
      closeBundle() {
        const { cpSync, rmSync, existsSync } = fs;
        const dest = "dist/multiplayer";
        try { rmSync(dest, { recursive: true, force: true }); } catch (e) { /* fresh */ }
        if (existsSync("multiplayer")) {
          cpSync("multiplayer", dest, { recursive: true });
        }
      },
    },
  ],
  server: { port: 5173, host: "127.0.0.1" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
});
