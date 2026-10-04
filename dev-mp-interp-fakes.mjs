// Fake Cesium + viewer so the REAL multiplayer/remotePlanes.js can run under
// Node for the interpolation regression test. Only the surface remotePlanes
// actually touches is implemented.

class Color {
  constructor(r, g, b, a = 1) { this.r = r; this.g = g; this.b = b; this.a = a; }
  static fromCssColorString(css) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(css).replace("#", ""));
    if (!m) return new Color(1, 1, 1, 1);
    return new Color(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255, 1);
  }
  withAlpha(a) { return new Color(this.r, this.g, this.b, a); }
}
class Cartesian3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  static fromDegrees(lon, lat, alt = 0) { return new Cartesian3(lon, lat, alt); }
}
class Cartesian2 { constructor(x, y) { this.x = x; this.y = y; } }
class HeadingPitchRoll { constructor(h, p, r) { this.heading = h; this.pitch = p; this.roll = r; } }
class ConstantProperty { constructor(v) { this.value = v; } }
class DistanceDisplayCondition { constructor(n, f) { this.near = n; this.far = f; } }

globalThis.__fakeCesium = {
  Math: { toRadians: (d) => d * (Math.PI / 180), toDegrees: (r) => r * (180 / Math.PI) },
  Color, Cartesian3, Cartesian2, HeadingPitchRoll, ConstantProperty, DistanceDisplayCondition,
  Transforms: { headingPitchRollQuaternion: (pos, hpr) => new ConstantProperty([pos, hpr]) },
  LabelStyle: { FILL_AND_OUTLINE: 2 },
  VerticalOrigin: { BOTTOM: 0 },
};

globalThis.__fakeViewer = {
  entities: {
    add() { return { position: null, orientation: null, show: false, label: {}, model: {} }; },
    remove() {},
  },
};
