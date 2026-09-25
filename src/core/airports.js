/**
 * Airport + runway data.
 *
 * Source: OurAirports (ourairports.com/data) — public domain CSV, ~86k
 * airports and ~48k runways. We preprocess it at build time into a compact
 * binary-friendly JSON so the browser never parses 130k lines of CSV.
 *
 * Runway geometry is authoritative: the CSV carries each threshold's real
 * latitude, longitude, true heading, length and width. We draw the runway as
 * a rectangle between its two thresholds, which is exactly how it is oriented
 * on the ground.
 */

/** Air density at a given altitude, exponential approximation of the ISA. */
export function airDensity(altitudeM, cfg) {
  const scale = 44330 / (cfg.temperatureSeaLevel - 0.0065 * altitudeM);
  return cfg.densitySeaLevel * Math.exp(-altitudeM / scale);
}

export class AirportIndex {
  constructor(data) {
    this.airports = data.airports;
    this.attribution = data.attribution;
    this._grid = new Map();
    for (let i = 0; i < this.airports.length; i++) {
      const a = this.airports[i];
      const key = this._cell(a.lat, a.lon);
      let bucket = this._grid.get(key);
      if (!bucket) this._grid.set(key, (bucket = []));
      bucket.push(i);
    }
  }

  _cell(lat, lon) {
    // 2-degree cells: small enough to keep candidate lists short, large
    // enough that a jet at 250 m/s never outruns the lookup.
    return `${Math.floor(lat / 2)}:${Math.floor(lon / 2)}`;
  }

  /** Airports within `radiusM` of a point, nearest first. */
  near(lat, lon, radiusM, limit = 12) {
    const candidates = [];
    const span = Math.max(1, Math.ceil(radiusM / 111320 / 2) + 1);
    const latCell = Math.floor(lat / 2);
    const lonCell = Math.floor(lon / 2);
    for (let dLat = -span; dLat <= span; dLat++) {
      for (let dLon = -span; dLon <= span; dLon++) {
        const bucket = this._grid.get(`${latCell + dLat}:${lonCell + dLon}`);
        if (bucket) candidates.push(...bucket);
      }
    }
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
    const scored = [];
    for (const i of candidates) {
      const a = this.airports[i];
      const dx = (a.lon - lon) * mPerDegLon;
      const dy = (a.lat - lat) * mPerDegLat;
      const d = Math.hypot(dx, dy);
      if (d <= radiusM) scored.push({ airport: a, distance: d });
    }
    scored.sort((x, y) => x.distance - y.distance);
    return scored.slice(0, limit);
  }

  /** Longest runway of an airport, for spawn placement. */
  bestRunway(airport) {
    if (!airport.runways || !airport.runways.length) return null;
    let best = airport.runways[0];
    for (const r of airport.runways) if (r.length > best.length) best = r;
    return best;
  }
}

/**
 * Place an aircraft on a runway: at the approach threshold, on the ground,
 * pointed down the runway.
 */
export function spawnOnRunway(airport, runway, config) {
  const halfWidth = Math.max(runway.width, 20) / 2 + 6;
  // A few metres in from the threshold so the wheels are on tarmac, not the
  // displaced-threshold markings.
  const inset = 25;
  // NOTE: parenthesise the sum before dividing. Written as
  // `runway.lon + runway.endLon / 2` the division binds first and puts the
  // spawn in the wrong hemisphere entirely.
  const midLat = (runway.lat + runway.endLat) / 2;
  const midLon = (runway.lon + runway.endLon) / 2;
  const bearing = runway.heading * (Math.PI / 180);
  // Back along the runway axis by half its length, plus the inset.
  const back = runway.length / 2 - inset;
  const dLat = (-Math.cos(bearing) * back) / 111320;
  const dLon =
    (-Math.sin(bearing) * back) /
    (111320 * Math.cos((midLat * Math.PI) / 180));
  return {
    lat: midLat + dLat,
    lon: midLon + dLon,
    alt: airport.elev + 0.6,
    heading: runway.heading * (Math.PI / 180),
    airportName: airport.name,
    runwayIdent: runway.ident,
    halfWidth,
  };
}
