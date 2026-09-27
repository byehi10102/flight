/**
 * Geocoding and distance utilities.
 * Uses Nominatim (OpenStreetMap) — keyless, no API key required.
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

export async function reverseGeocode(lon, lat) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=5&addressdetails=1`
    );
    const data = await response.json();

    const place = formatPlace(data && data.address);
    if (place) return place.short;
  } catch (error) {
    console.error("Reverse geocoding error:", error);
  }
  // No address (open ocean, remote land, rate-limited): fall back to a
  // coordinates label so location displays never stick on "fetching...".
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "W";
  return `REMOTE AREA ${Math.abs(lat).toFixed(1)}°${latDir} ${Math.abs(lon).toFixed(1)}°${lonDir}`;
}

/** Full address hierarchy for the spawn picker: city, county, state, country. */
export async function reverseGeocodeDetailed(lon, lat) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`
    );
    const data = await response.json();
    const place = formatPlace(data && data.address);
    if (place) return place;
  } catch (error) {
    console.error("Reverse geocoding error:", error);
  }
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "W";
  const label = `REMOTE AREA ${Math.abs(lat).toFixed(1)}°${latDir} ${Math.abs(lon).toFixed(1)}°${lonDir}`;
  return { city: null, county: null, state: null, country: null, label, short: label };
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
