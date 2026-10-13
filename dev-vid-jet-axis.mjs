// Isolates the STATIC high-contrast object (the jet holds its pose; only the
// streaks move) and measures its screen-space principal axis:
//   jet pixels ~= where |f0 - f30| is small AND local contrast is high.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SRC = "C:/Users/jaxzc.JACKSON/AppData/Local/Temp/opencode/original-loading-scene.mp4";
const W = 1920, H = 1080;

function decode(n) {
  const out = `C:/Users/jaxzc.JACKSON/AppData/Local/Temp/opencode/jet_f${n}.raw`;
  spawnSync("ffmpeg", ["-y", "-i", SRC, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1",
    "-pix_fmt", "gray", "-f", "rawvideo", out], { stdio: "ignore" });
  return fs.readFileSync(out);
}

const f0 = decode(0);
const f30 = decode(30);
if (f0.length !== W * H || f30.length !== W * H) { console.error("decode fail"); process.exit(1); }

// local contrast: |pixel - 5x5 mean| via separable box blur
function boxBlur(img, r) {
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += img[y * W + Math.min(W - 1, Math.max(0, x))];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = acc / (2 * r + 1);
      acc += img[y * W + Math.min(W - 1, x + r + 1)] - img[y * W + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}

const blur0 = boxBlur(f0, 4);
let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
const hits = [];
for (let y = 8; y < H - 8; y += 1) {
  for (let x = 8; x < W - 8; x += 1) {
    const i = y * W + x;
    const diff = Math.abs(f0[i] - f30[i]);
    const contrast = Math.abs(f0[i] - blur0[i]);
    if (diff < 3 && contrast > 25) {  // static + high-frequency detail
      hits.push([x, y]);
      sx += x; sy += y; n++;
    }
  }
}
if (n < 50) { console.error("too few jet pixels:", n); process.exit(1); }
const cx = sx / n, cy = sy / n;
for (const [x, y] of hits) { sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy); }
const cov = [[sxx / n, sxy / n], [sxy / n, syy / n]];
// principal axis angle of the covariance ellipse
const theta = 0.5 * Math.atan2(2 * cov[0][1], cov[0][0] - cov[1][1]);
const eig = ((cov[0][0] + cov[1][1]) / 2) + Math.hypot((cov[0][0] - cov[1][1]) / 2, cov[0][1]);
const ratio = eig / (((cov[0][0] + cov[1][1]) / 2) - Math.hypot((cov[0][0] - cov[1][1]) / 2, cov[0][1]) + 1e-9);
console.log(JSON.stringify({
  pixels: n, centroid: [Math.round(cx), Math.round(cy)],
  angleDeg: +(theta * 180 / Math.PI).toFixed(1),  // 0 = horizontal, + = clockwise/down
  elongation: +ratio.toFixed(2),
}));
// sample the extremes along the axis to find which end is the NOSE:
// the nose (pointy cone) is the FARTHER extreme from the centroid with a
// tapering profile - approximate by checking brightness structure at both
// ends of the major axis.
const len = Math.sqrt(eig) * 2.2;
const dirx = Math.cos(theta), diry = Math.sin(theta);
const ends = [[cx + dirx * len, cy + diry * len], [cx - dirx * len, cy - diry * len]];
for (const [ex, ey] of ends) {
  let c = 0, k = 0;
  for (let dy2 = -6; dy2 <= 6; dy2++) for (let dx2 = -6; dx2 <= 6; dx2++) {
    const x = Math.round(ex + dx2), y = Math.round(ey + dy2);
    if (x >= 0 && x < W && y >= 0 && y < H) { c += Math.abs(f0[y * W + x] - blur0[y * W + x]); k++; }
  }
  console.log(`end (${Math.round(ex)},${Math.round(ey)}) avg contrast ${(c / k).toFixed(1)}`);
}
