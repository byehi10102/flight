/**
 * Shared geographic motion for projectiles (same signature as the
 * movePosition in src/main.js; kept here so weapon files don't import
 * main.js and create a cycle).
 */
export function movePosition(lon, lat, alt, heading, pitch, distance) {
  const headingRad = (heading * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  const R = 6371000;
  const dLat = (distance * Math.cos(headingRad) * Math.cos(pitchRad)) / R;
  const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const dLon = (distance * Math.sin(headingRad) * Math.cos(pitchRad)) / (R * cosLat);
  const dAlt = distance * Math.sin(pitchRad);
  return {
    lon: lon + (dLon * 180) / Math.PI,
    lat: lat + (dLat * 180) / Math.PI,
    alt: alt + dAlt,
  };
}
