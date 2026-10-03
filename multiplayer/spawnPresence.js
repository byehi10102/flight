/**
 * Peer presence on the spawn-selection map.
 *
 * Shows where the other player is looking (their map centre, broadcast at a
 * few Hz) and, the moment they commit, the point they placed. Live cursor
 * tracking can lag on a slow link, so the placed dot is the guaranteed
 * signal: it is sent once and stays put until they move it.
 *
 * This file loads RAW (outside the app bundler), so Cesium arrives through
 * createSpawnPresence(ctx) instead of a bare import.
 */

let Cesium = null;

/** Wire up the host app's Cesium namespace and return a new instance. */
export function createSpawnPresence(ctx) {
  Cesium = ctx.Cesium;
  return new SpawnPresence(ctx.viewer);
}
export class SpawnPresence {
  constructor(viewer) {
    this.viewer = viewer;
    /** peerId -> { dot, cursor, colour } */
    this.markers = new Map();
    this._palette = [
      Cesium.Color.fromCssColorString("#ff6a3d"),
      Cesium.Color.fromCssColorString("#3da5ff"),
      Cesium.Color.fromCssColorString("#ffd23d"),
      Cesium.Color.fromCssColorString("#9b6aff"),
    ];
    this._colourIndex = 0;
  }

  _nextColour() {
    const c = this._palette[this._colourIndex % this._palette.length];
    this._colourIndex++;
    return c;
  }

  ensure(peerId, callsign) {
    let m = this.markers.get(peerId);
    if (m) {
      if (callsign) m.callsign = callsign;
      return m;
    }
    const colour = this._nextColour();
    m = {
      callsign: callsign || "PILOT",
      colour,
      dot: null,
      cursor: null,
      last: null,
    };
    try {
      m.cursor = this.viewer.entities.add({
        show: false,
        point: {
          pixelSize: 12,
          color: colour.withAlpha(0.55),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      m.dot = this.viewer.entities.add({
        show: false,
        position: Cesium.Cartesian3.fromDegrees(0, 0),
        billboard: {
          image: _pinDataUri(colour),
          width: 34,
          height: 44,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: m.callsign,
          font: "600 12px Consolas, monospace",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: colour,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -34),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } catch (e) {
      m.dot = null;
      m.cursor = null;
    }
    this.markers.set(peerId, m);
    return m;
  }

  setCallsign(peerId, callsign) {
    const m = this.markers.get(peerId);
    if (!m || !callsign) return;
    m.callsign = callsign;
    try {
      if (m.dot) m.dot.label.text = new Cesium.ConstantProperty(callsign);
    } catch (e) { /* cosmetic */ }
  }

  /** data: { camLon, camLat, lon, lat, placed } */
  setPresence(peerId, data) {
    if (!data || typeof data !== "object") return;
    const m = this.ensure(peerId);
    m.last = data;
    try {
      if (m.cursor) {
        if (Number.isFinite(data.camLon) && Number.isFinite(data.camLat)) {
          m.cursor.position = Cesium.Cartesian3.fromDegrees(data.camLon, data.camLat);
          m.cursor.show = !data.placed;
        } else {
          m.cursor.show = false;
        }
      }
      if (m.dot) {
        if (data.placed && Number.isFinite(data.lon) && Number.isFinite(data.lat)) {
          m.dot.position = Cesium.Cartesian3.fromDegrees(data.lon, data.lat);
          m.dot.show = true;
          if (m.cursor) m.cursor.show = false;
        } else {
          m.dot.show = false;
        }
      }
    } catch (e) { /* cosmetic */ }
  }

  /** Did this peer commit a spawn point? */
  hasPlaced(peerId) {
    const m = this.markers.get(peerId);
    return !!(m && m.last && m.last.placed);
  }

  remove(peerId) {
    const m = this.markers.get(peerId);
    if (!m) return;
    try {
      if (m.dot) this.viewer.entities.remove(m.dot);
      if (m.cursor) this.viewer.entities.remove(m.cursor);
    } catch (e) { /* already gone */ }
    this.markers.delete(peerId);
  }

  clear() {
    for (const id of [...this.markers.keys()]) this.remove(id);
    this.markers.clear();
  }
}

/** Small pin drawn to a canvas so peers are distinguishable by colour. */
function _pinDataUri(colour) {
  try {
    const c = document.createElement("canvas");
    c.width = 34;
    c.height = 44;
    const g = c.getContext("2d");
    const css = colour.toCssColorString();
    g.fillStyle = css;
    g.beginPath();
    g.arc(17, 15, 11, Math.PI * 0.75, Math.PI * 0.25, false);
    g.lineTo(17, 42);
    g.closePath();
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.55)";
    g.lineWidth = 2;
    g.stroke();
    g.globalCompositeOperation = "destination-out";
    g.beginPath();
    g.arc(17, 15, 4.5, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png");
  } catch (e) {
    return undefined;
  }
}
