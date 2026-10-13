// Estimates the dominant global translation between two frames of the
// original fly-through: the cloud streaks dominate the frame, so the
// best-shift IS the streaks' screen motion. The jet's apparent flight
// direction is the OPPOSITE of the streak motion.
// Usage: node dev-vid-motion.mjs <rawFramesPrefixA> <rawFramesPrefixB>
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const SRC = process.argv[2] || "C:/Users/jaxzc.JACKSON/AppData/Local/Temp/opencode/original-loading-scene.mp4";
const W = 1920, H = 1080, N = 3; // frames 0..2

function decode(n) {
  const out = `C:/Users/jaxzc.JACKSON/AppData/Local/Temp/opencode/motion_f${n}.raw`;
  spawnSync("ffmpeg", ["-y", "-i", SRC, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1",
    "-pix_fmt", "gray", "-f", "rawvideo", out], { stdio: "ignore" });
  return fs.readFileSync(out);
}

const a = decode(0);
const b = decode(30); // half a loop apart: maximum expected difference
const a2 = decode(2);
if (a.length !== W * H || b.length !== W * H) {
  console.error("decode failed", a.length, b.length);
  process.exit(1);
}

// Search the best integer shift over +/-48 px, coarse-to-fine on a center crop.
function sad(dx, dy) {
  let s = 0, count = 0;
  const x0 = Math.max(48, 640 + dx), x1 = Math.min(W - 48, 1280 + dx);
  const y0 = Math.max(48, 270 + dy), y1 = Math.min(H - 48, 810 + dy);
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const ia = y * W + x;
      const ib = (y - dy) * W + (x - dx);
      s += Math.abs(a[ia] - b[ib]);
      count++;
    }
  }
  return s / count;
}

let best = null;
for (let dy = -48; dy <= 48; dy += 1) {
  for (let dx = -48; dx <= 48; dx += 1) {
    const e = sad(dx, dy);
    if (!best || e < best.e) best = { dx, dy, e };
  }
}
console.log("f0 vs f30 (half loop):", JSON.stringify(best));
const mag = Math.hypot(best.dx, best.dy);
console.log(`half-loop streak motion: (${best.dx}, ${best.dy}) px, |m|=${mag.toFixed(1)} (y down)`);
if (mag > 1) {
  console.log(`jet apparent flight dir (opposite): (${-best.dx}, ${-best.dy})`);
  console.log(`jet screen angle: ${Math.atan2(-best.dy, -best.dx) * 180 / Math.PI} deg (0=right, 90=down)`);
} else {
  console.log("little measurable translation - streaks drift too slowly to lock");
}
