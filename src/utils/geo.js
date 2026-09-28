/**
 * Geocoding and distance utilities — keyless, no API key required.
 *
 * Forward search (main.js) tries Nominatim → Photon → Open-Meteo in order.
 * Reverse uses Nominatim first (best detail: suburbs, peaks, addresses)
 * with BigDataCloud's free client API as fallback — it answers where
 * Nominatim returns nothing, including open oceans ("Pacific Ocean"),
 * plus city/county/state/country everywhere else.
 */

function formatPlace(addr) {
  if (!addr) return null;
  const city = addr.city || addr.town || addr.village || addr.hamlet || addr.suburb || addr.neighbourhood;
  const county = addr.county || addr.state_district;
  const state = addr.state || addr.region || addr.province;
  const country = addr.country;
  const parts = [city, county, state, country].filter(Boolean);
  if (parts.length === 0) return null;
  return {
    city: city || null,
    county: county || null,
    state: state || null,
    country: country || null,
    // Full hierarchy: CITY, COUNTY, STATE, COUNTRY.
    label: parts.join(", ").toUpperCase(),
    // Short form for 3D labels and banners.
    short: [city, state || country].filter(Boolean).join(", ").toUpperCase(),
  };
}

/** BigDataCloud free client response → same {label, short} shape. */
function formatBigDataCloud(d) {
  if (!d || typeof d !== "object") return null;
  const admin = d.localityInfo?.administrative || [];
  const info = d.localityInfo?.informative || [];
  // Skip timezone pseudo-places ("Etc/GMT+10", "America/...").
  const isTz = (i) => /time zone/i.test(i?.description || "") || /^Etc\//.test(i?.name || "");
  if (d.countryName) {
    // locality is the actual town ("Anaheim"); city is the metro label
    // ("Anaheim-Santa Ana-Garden Grove") — prefer the town.
    const city = d.locality || d.city || null;
    const county = admin.find((a) => a.adminLevel === 6)?.name || null;
    const state = d.principalSubdivision || null;
    const parts = [city, county, state, d.countryName].filter(Boolean);
    if (parts.length === 0) return null;
    return {
      city, county, state, country: d.countryName,
      label: parts.join(", ").toUpperCase(),
      short: [city, state || d.countryName].filter(Boolean).join(", ").toUpperCase(),
    };
  }
  // No country: ocean, sea, or unclaimed land — name the water/region.
  const feat = info.find((i) => !isTz(i)) || null;
  const name = feat?.name || d.locality || null;
  if (!name) return null;
  const extra = d.locality && d.locality !== name ? d.locality : null;
  const label = [name, extra].filter(Boolean).join(" · ").toUpperCase();
  return { city: null, county: null, state: null, country: null, label, short: name.toUpperCase() };
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Shared reverse core: Nominatim detail first, BigDataCloud second. */
async function reverseCore(lon, lat, zoom) {
  try {
    const data = await fetchJson(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=${zoom}&addressdetails=1`,
      6000
    );
    const place = formatPlace(data && data.address);
    if (place) return place;
  } catch (error) { /* fall through to BigDataCloud */ }
  try {
    const bdc = await fetchJson(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      8000
    );
    const place = formatBigDataCloud(bdc);
    if (place) return place;
  } catch (error) { /* caller falls back */ }
  return null;
}

/** Short "CITY, STATE" / ocean name for the HUD banner. Null = keep last. */
export async function reverseGeocode(lon, lat) {
  const place = await reverseCore(lon, lat, 10);
  return place ? place.short : null;
}

/** Full address hierarchy for the spawn picker. Null = caller falls back. */
export async function reverseGeocodeDetailed(lon, lat) {
  return reverseCore(lon, lat, 14);
}

export function calculateDistance(lon1, lat1, lon2, lat2) {
  const R = 6371e3;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}
