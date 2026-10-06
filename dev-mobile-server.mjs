// Static server for the mobile-controls test: serves the isolated touch page
// and the REAL shipped src/ modules (no copies), plus the built app for the
// integration phase.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  "/touch": path.join(here, "dev-touch-page.html"),
  "/": path.join(here, "dev-touch-page.html"),
};
const MIME = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };

export function startMobileTestServer(port = 4242) {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/favicon.ico") { res.writeHead(204).end(); return; }
    let file = FILES[url];
    if (!file && url.startsWith("/src/")) file = path.join(here, url.slice(1));
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "text/plain" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
