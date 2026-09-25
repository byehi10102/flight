/**
 * Place search + airport jump + spawn panel.
 *
 * Photon (photon.komoot.io) is a keyless OpenStreetMap geocoder, so the player
 * can type "my house", "Eiffel Tower" or "KSEA" and jump there with no API
 * key. The airport list comes from the same OurAirports payload the runways
 * are drawn from, so a jump and the runway geometry always agree.
 */
import { Viewer } from "cesium";

const PHOTON = "https://photon.komoot.io/api/";

export class LocationPanel {
  constructor(root, viewer, index, onJump) {
    this.viewer = viewer;
    this.index = index;
    this.onJump = onJump;
    this.node = document.createElement("div");
    this.node.className = "panel";
    root.appendChild(this.node);

    this.node.innerHTML = `
      <div class="panel-title">FLIGHT CONTROL</div>
      <input class="panel-input" id="place-input" type="search"
             placeholder="Search a place, or an airport code" autocomplete="off"
             spellcheck="false" />
      <div class="panel-results" id="place-results"></div>
      <div class="panel-section">NEARBY AIRPORTS</div>
      <div class="panel-results" id="airport-results"></div>
      <div class="panel-section">WORLD</div>
      <div class="panel-presets" id="presets"></div>
      <div class="panel-help">
        <b>Ground</b> W accelerate · S brakes · A/D steer<br/>
        <b>Air</b> W throttle · A/D or ←/→ turn · ↑ climb · ↓ descend<br/>
        Release ↑/↓ and the aircraft levels and holds altitude.
      </div>
    `;
    this.input = this.node.querySelector("#place-input");
    this.results = this.node.querySelector("#place-results");
    this.airportResults = this.node.querySelector("#airport-results");
    this.presets = this.node.querySelector("#presets");
    this._debounce = 0;

    this.input.addEventListener("input", () => {
      clearTimeout(this._debounce);
      const q = this.input.value.trim();
      if (q.length < 3) {
        this.results.innerHTML = "";
        return;
      }
      this._debounce = setTimeout(() => this._search(q), 320);
    });
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // typing must not fly the aircraft
    });
  }

  async _search(query) {
    const term = /^[A-Za-z]{3,4}$/.test(query.trim())
      ? `${query.trim()} airport`
      : query;
    try {
      const url = `${PHOTON}?q=${encodeURIComponent(term)}&limit=6`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      const features = json.features || [];
      this.results.innerHTML = "";
      for (const f of features) {
        const [lon, lat] = f.geometry.coordinates;
        const props = f.properties || {};
        const name = props.name || query;
        const detail = [props.city, props.state, props.country].filter(Boolean).join(", ");
        this.results.appendChild(
          this._row(name, detail, () => this.onJump({ lat, lon, height: 1500, label: name })),
        );
      }
      if (!features.length) {
        this.results.innerHTML = `<div class="panel-empty">No matches</div>`;
      }
    } catch (error) {
      this.results.innerHTML = `<div class="panel-empty">Search unavailable</div>`;
    }
  }

  /** Called each frame with the current position; keeps the list relevant. */
  updateAirports(lat, lon) {
    if (!this.index) return;
    const near = this.index.near(lat, lon, 80000, 4);
    if (!near.length) return;
    const key = near.map((n) => n.airport.id).join(",");
    if (key === this._airportKey) return;
    this._airportKey = key;
    this.airportResults.innerHTML = "";
    for (const { airport, distance } of near) {
      const code = airport.iata || airport.icao || "";
      const name = `${code ? `${code} · ` : ""}${airport.name}`;
      const detail = `${(distance / 1000).toFixed(0)} km · ${airport.runways.length} runway${airport.runways.length > 1 ? "s" : ""}`;
      this.airportResults.appendChild(
        this._row(name, detail, () =>
          this.onJump({ airport, label: name, spawn: true }),
        ),
      );
    }
  }

  _row(title, detail, onClick) {
    const row = document.createElement("button");
    row.className = "panel-row";
    row.type = "button";
    row.innerHTML = `<span class="row-title"></span><span class="row-detail"></span>`;
    row.querySelector(".row-title").textContent = title;
    row.querySelector(".row-detail").textContent = detail;
    row.addEventListener("click", onClick);
    return row;
  }
}

export const PRESETS = [
  { label: "Seattle", lat: 47.4502, lon: -122.3088, height: 1200, label2: "KSEA" },
  { label: "Manhattan", lat: 40.758, lon: -73.9855, height: 1200 },
  { label: "Matterhorn", lat: 45.9763, lon: 7.6586, height: 3000 },
  { label: "Grand Canyon", lat: 36.1069, lon: -112.1129, height: 2000 },
  { label: "Mount Everest", lat: 27.9881, lon: 86.925, height: 9000 },
  { label: "Sydney Harbour", lat: -33.8568, lon: 151.2153, height: 900 },
  { label: "Rio de Janeiro", lat: -22.9519, lon: -43.2105, height: 1200 },
  { label: "Mount Fuji", lat: 35.3606, lon: 138.7274, height: 3500 },
];
