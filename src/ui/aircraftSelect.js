/**
 * Aircraft selection — its own FULL SCREEN between the menu and the spawn
 * map (not an overlay on the menu: the menu bled through the old overlay
 * and the single column read cramped). Desktop gets a 2x2 card grid; mobile
 * gets one column with compact cards. The choice persists (localStorage)
 * and is remembered for the session: NEW LOCATION after a crash does not
 * re-ask. Deleting this module only removes the screen (main.js guards it).
 */
import { CONFIG } from "../core/config.js";

const STORAGE_KEY = "skyward_aircraft";

/** Monochrome inline-SVG glyphs (emoji rendered in clashing full colour). */
const GLYPHS = {
  jet: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M6 34 L38 30 L30 18 L36 18 L50 30 L58 30 C60 30 60 34 58 34 L50 34 L36 46 L30 46 L38 34 L14 38 L10 42 L6 42 L8 36 Z"/></svg>`,
  airliner: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M4 33 C10 28 18 27 26 27 L30 16 L36 16 L34 27 L52 28 C58 28.5 58 35.5 52 36 L34 37 L36 48 L30 48 L26 37 C18 37 10 36 4 33 Z"/><path fill="currentColor" d="M22 20 L26 12 L28 12 L26 20 Z M22 46 L26 52 L28 52 L26 44 Z" opacity=".7"/></svg>`,
  drone: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M8 32 C14 29 20 28 28 28 L32 20 L38 20 L36 28 L54 29 C59 29.4 59 34.6 54 35 L36 36 L38 44 L32 44 L28 36 C20 36 14 35 8 32 Z"/><circle fill="currentColor" cx="44" cy="31" r="4" opacity=".85"/><path fill="currentColor" d="M18 24 L24 24 L24 26 L18 26 Z" opacity=".7"/></svg>`,
  heli: `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M14 12 L50 12 L50 15 L34 15 L34 19 L44 19 C50 19 52 24 50 30 C48 36 42 40 34 40 L26 40 C18 40 14 34 14 27 Z"/><rect fill="currentColor" x="12" y="42" width="26" height="3" rx="1.5"/><path fill="currentColor" d="M18 40 L20 44 L36 44 L38 40 Z" opacity=".7"/><path fill="currentColor" d="M44 20 L56 20 L56 22.5 L46 22.5 Z"/><path fill="currentColor" d="M53 10 L55 10 L55 22.5 L53 22.5 Z" opacity=".9"/></svg>`,
};

export function getFleet() {
  return CONFIG.fleet;
}

/** The chosen vehicle (falls back to the F-15, and to the first entry). */
export function getSelectedAircraft() {
  let id = null;
  try { id = localStorage.getItem(STORAGE_KEY); } catch (e) { /* privacy mode */ }
  return CONFIG.fleet.find((v) => v.id === id) || CONFIG.fleet.find((v) => v.id === "f15") || CONFIG.fleet[0];
}

let screen = null;
let selected = null;

const CONTROLS_LINE = {
  jet: "W/S THROTTLE · ARROWS PITCH/ROLL · SPACE BOOST",
  heli: "W/S COLLECTIVE · ARROWS CYCLIC · A/D PEDALS",
};

function buildScreen(handlers) {
  if (screen) return screen;
  screen = document.createElement("div");
  screen.id = "aircraftSelect";
  screen.className = "hidden";
  const cards = CONFIG.fleet.map((v) => `
    <button type="button" class="fleet-card ${v.type}" data-id="${v.id}">
      <span class="fleet-glyph">${GLYPHS[v.id] || GLYPHS.jet}</span>
      <span class="fleet-text">
        <span class="fleet-name">${v.name}</span>
        <span class="fleet-role">${v.role}</span>
        <span class="fleet-spec">${v.spec}</span>
        <span class="fleet-controls">${CONTROLS_LINE[v.type] || CONTROLS_LINE.jet}</span>
      </span>
      <span class="fleet-check" aria-hidden="true"></span>
    </button>`).join("");

  screen.innerHTML = `
    <div class="as-backdrop"></div>
    <div class="as-content">
      <div class="as-kicker">SKYWARD</div>
      <h1 class="as-title">CHOOSE YOUR AIRCRAFT</h1>
      <p class="as-sub">Pick the machine, then pick your spawn point.</p>
      <div class="fleet-grid" id="fleetGrid">${cards}</div>
      <div class="as-actions">
        <button id="fleetGoBtn" class="menu-btn as-primary">CONTINUE ▸</button>
        <button id="fleetBackBtn" class="menu-btn menu-btn-ghost as-ghost">BACK</button>
      </div>
    </div>`;
  document.body.appendChild(screen);

  for (const card of screen.querySelectorAll(".fleet-card")) {
    card.addEventListener("click", () => {
      selected = CONFIG.fleet.find((v) => v.id === card.dataset.id);
      for (const el of screen.querySelectorAll(".fleet-card")) {
        el.classList.toggle("sel", el === card);
      }
    });
  }
  screen.querySelector("#fleetGoBtn").addEventListener("click", () => {
    const vehicle = selected || getSelectedAircraft();
    try { localStorage.setItem(STORAGE_KEY, vehicle.id); } catch (e) { /* privacy mode */ }
    close();
    handlers.onDone?.(vehicle);
  });
  screen.querySelector("#fleetBackBtn").addEventListener("click", () => {
    close();
    handlers.onBack?.();
  });
  return screen;
}

function close() {
  if (screen) screen.classList.add("hidden");
}

/** Show the selector as its own screen. `onDone(vehicle)` fires on CONTINUE;
 *  `onBack` fires on BACK (the caller restores the menu). */
export function openAircraftSelect(handlers = {}) {
  selected = getSelectedAircraft();
  const el = buildScreen(handlers);
  el.classList.remove("hidden");
  for (const card of el.querySelectorAll(".fleet-card")) {
    card.classList.toggle("sel", card.dataset.id === selected.id);
  }
}
