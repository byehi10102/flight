/**
 * Aircraft selection — the screen between SINGLE PLAYER and the spawn map.
 *
 * The flow worldflightsimulator.com uses (their setup card, step 1 "SELECT
 * AIRCRAFT" → step 2 departure): pick the machine FIRST, then the place, so
 * the spawn picker and the flight itself already know what they are loading.
 *
 * The choice persists (localStorage) and is remembered for the whole session:
 * NEW LOCATION after a crash does not re-ask. The overlay builds itself, so
 * deleting this module only removes the screen (main.js guards the import).
 */
import { CONFIG } from "../core/config.js";

const STORAGE_KEY = "skyward_aircraft";

export function getFleet() {
  return CONFIG.fleet;
}

/** The chosen vehicle (falls back to the F-15, and to the first entry). */
export function getSelectedAircraft() {
  let id = null;
  try { id = localStorage.getItem(STORAGE_KEY); } catch (e) { /* privacy mode */ }
  return CONFIG.fleet.find((v) => v.id === id) || CONFIG.fleet.find((v) => v.id === "f15") || CONFIG.fleet[0];
}

let overlay = null;
let selected = null;

function buildOverlay(onDone) {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "aircraftSelect";
  overlay.className = "overlay hidden";
  overlay.innerHTML = `
    <div class="menu-container">
      <div class="menu-content">
        <div class="menu-header">
          <span class="logo-main">CHOOSE YOUR AIRCRAFT</span>
        </div>
        <p class="menu-desc">Pick the machine, then pick your spawn point.</p>
        <div id="fleetList" class="fleet-list"></div>
        <button id="fleetGoBtn" class="menu-btn">CONTINUE ▸</button>
        <button id="fleetBackBtn" class="menu-btn menu-btn-ghost">BACK</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const list = overlay.querySelector("#fleetList");
  for (const vehicle of CONFIG.fleet) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "fleet-card" + (vehicle.type === "heli" ? " heli" : "");
    card.dataset.id = vehicle.id;
    card.innerHTML = `
      <span class="fleet-glyph">${vehicle.type === "heli" ? "🚁" : "✈"}</span>
      <span class="fleet-name">${vehicle.name}</span>
      <span class="fleet-role">${vehicle.role}</span>
      <span class="fleet-spec">${vehicle.spec}</span>`;
    card.addEventListener("click", () => {
      selected = vehicle;
      for (const el of list.querySelectorAll(".fleet-card")) {
        el.classList.toggle("sel", el.dataset.id === vehicle.id);
      }
    });
    list.appendChild(card);
  }
  overlay.querySelector("#fleetGoBtn").addEventListener("click", () => {
    const vehicle = selected || getSelectedAircraft();
    try { localStorage.setItem(STORAGE_KEY, vehicle.id); } catch (e) { /* privacy mode */ }
    close();
    onDone?.(vehicle);
  });
  overlay.querySelector("#fleetBackBtn").addEventListener("click", () => {
    close();
  });
  return overlay;
}

function close() {
  if (overlay) overlay.classList.add("hidden");
}

/** Show the selector; `onDone(vehicle)` fires on CONTINUE. BACK fires nothing
 *  (the caller stays on the menu). */
export function openAircraftSelect(onDone) {
  selected = getSelectedAircraft();
  const el = buildOverlay(onDone);
  el.classList.remove("hidden");
  for (const card of el.querySelectorAll(".fleet-card")) {
    card.classList.toggle("sel", card.dataset.id === selected.id);
  }
}
