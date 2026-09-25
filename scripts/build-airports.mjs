/**
 * Preprocess OurAirports CSV into a compact JSON payload.
 *
 * Source: https://davidmegginson.github.io/ourairports-data/ (public domain)
 *   airports.csv — id, name, iata, icao, lat, lon, elev_ft, type
 *   runways.csv  — airport_ref, le_/he_ threshold lat/lon, true heading,
 *                  length_ft, width_ft, surface
 *
 * We keep only airports that have at least one usable runway (both threshold
 * coordinates present), because a runway we cannot place is a runway we
 * cannot draw. Coordinates are rounded to 5 decimals (~1.1 m) and elevations
 * to whole feet, which keeps the payload small without visibly moving
 * anything.
 *
 * Run: npm run data:airports
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const cacheDir = resolve(root, ".cache");
const outPath = resolve(root, "public/data/airports.json");

const SOURCES = {
  airports:
    "https://davidmegginson.github.io/ourairports-data/airports.csv",
  runways: "https://davidmegginson.github.io/ourairports-data/runways.csv",
};

/** Minimal RFC-4180 CSV parser — the OurAirports files use quoted fields. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows.map((r) => {
    const o = {};
    for (let i = 0; i < header.length; i++) o[header[i]] = r[i];
    return o;
  });
}

async function fetchOrCache(name) {
  const cached = resolve(cacheDir, `${name}.csv`);
  if (existsSync(cached)) return readFile(cached, "utf8");
  process.stdout.write(`  downloading ${name}.csv … `);
  const res = await fetch(SOURCES[name]);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, text);
  console.log(`${(text.length / 1024).toFixed(0)} KiB`);
  return text;
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r5 = (v) => Math.round(v * 1e5) / 1e5;

async function main() {
  console.log("Building airport index from OurAirports (public domain)…");
  const airportRows = parseCsv(await fetchOrCache("airports"));
  const runwayRows = parseCsv(await fetchOrCache("runways"));
  console.log(`  parsed ${airportRows.length} airports, ${runwayRows.length} runways`);

  const runwaysByRef = new Map();
  let usableRunways = 0;
  for (const r of runwayRows) {
    const leLat = num(r.le_latitude_deg);
    const leLon = num(r.le_longitude_deg);
    const heLat = num(r.he_latitude_deg);
    const heLon = num(r.he_longitude_deg);
    const heading = num(r.le_heading_degT);
    const length = num(r.length_ft);
    if (leLat === null || leLon === null || heLat === null || heLon === null) continue;
    if (heading === null || length === null) continue;
    usableRunways++;
    const list = runwaysByRef.get(r.airport_ref) || [];
    list.push({
      ident: r.le_ident || r.he_ident || "",
      lat: r5(leLat),
      lon: r5(leLon),
      endLat: r5(heLat),
      endLon: r5(heLon),
      heading,
      length: Math.round(length),
      width: Math.round(num(r.width_ft) || 60),
      surface: r.surface || "unknown",
    });
    runwaysByRef.set(r.airport_ref, list);
  }
  console.log(`  ${usableRunways} runways have complete geometry`);

  const airports = [];
  for (const a of airportRows) {
    const runways = runwaysByRef.get(a.id);
    if (!runways || !runways.length) continue;
    const lat = num(a.latitude_deg);
    const lon = num(a.longitude_deg);
    if (lat === null || lon === null) continue;
    airports.push({
      id: a.id,
      name: a.name,
      iata: a.iata_code || "",
      icao: a.icao_code || "",
      lat: r5(lat),
      lon: r5(lon),
      elev: Math.round((num(a.elevation_ft) || 0) * 0.3048),
      runways,
    });
  }
  airports.sort((x, y) => y.runways.length - x.runways.length);
  console.log(`  ${airports.length} airports kept (have >=1 usable runway)`);

  const payload = {
    generated: new Date().toISOString(),
    attribution:
      "Airport & runway data: OurAirports (public domain), ourairports.com/data",
    source: SOURCES.airports,
    airports,
  };
  await mkdir(dirname(outPath), { recursive: true });
  const json = JSON.stringify(payload);
  await writeFile(outPath, json);
  console.log(
    `  wrote ${outPath} — ${(json.length / 1024 / 1024).toFixed(2)} MiB, ${airports.length} airports`,
  );
}

main().catch((error) => {
  console.error("airport build failed:", error);
  process.exitCode = 1;
});
