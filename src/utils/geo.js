/**
 * Geocoding and distance utilities.
 * Uses Nominatim (OpenStreetMap) — keyless, no API key required.
 */

export async function reverseGeocode(lon, lat) {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=5&addressdetails=1`
    );
    const data = await response.json();

    if (data && data.address) {
      const addr = data.address;
      const state = addr.state || addr.region || addr.province;
      const country = addr.country;

      if (state && country) {
        return `${state}, ${country}`.toUpperCase();
      } else if (country) {
        return country.toUpperCase();
      }
    }
  } catch (error) {
    console.error("Reverse geocoding error:", error);
  }
  // No address (open ocean, remote land, rate-limited): fall back to a
  // coordinates label so location displays never stick on "fetching...".
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "E" : "W";
  return `REMOTE AREA ${Math.abs(lat).toFixed(1)}°${latDir} ${Math.abs(lon).toFixed(1)}°${lonDir}`;
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
