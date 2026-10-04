// Static server for the manual-WebRTC browser test: serves the test page and
// the GAME's real multiplayer/manual.js (no copy, so we test the shipped file).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Serve the REAL multiplayer/manual.js so the handshake test exercises the
// shipped file rather than a copy.
const MANUAL_JS = path.join(here, "multiplayer", "manual.js");

export function startServer(port = 4123) {
  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/manual.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fs.readFileSync(MANUAL_JS));
      return;
    }
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(path.join(here, "dev-mp-manual-page.html")));
      return;
    }
    res.writeHead(404).end("no");
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
