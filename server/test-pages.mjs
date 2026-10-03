// Syntax-checks the inline scripts of the demo pages (they run in a
// browser, so this only proves they parse — but a typo there would
// otherwise only show up when someone opens the page).
import fs from "node:fs";
import vm from "node:vm";

let fail = 0;
for (const file of ["index.html", "demo-2d.html"]) {
  const html = fs.readFileSync(file, "utf8");
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*importmap)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => s.trim());
  let ok = true;
  scripts.forEach((src, i) => {
    try {
      // Parse only: compiling as a module catches import/await misuse too.
      new vm.SourceTextModule(src);
    } catch (e) {
      // Fall back to a classic script parse (import maps / non-module scripts).
      try {
        new vm.Script(src);
      } catch (e2) {
        ok = false;
        console.log(`FAIL ${file} script#${i + 1}: ${e2.message}`);
      }
    }
  });
  if (ok) console.log(`PASS ${file}: ${scripts.length} inline script(s) parse`);
  else fail++;
}

// The import map must be valid JSON too.
const html = fs.readFileSync("index.html", "utf8");
const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/i);
try {
  JSON.parse(map[1]);
  console.log("PASS index.html: import map is valid JSON");
} catch (e) {
  console.log("FAIL index.html: import map is not valid JSON — " + e.message);
  fail++;
}

process.exit(fail ? 1 : 0);
