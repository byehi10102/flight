// Inspect the downloaded poly.pizza "GLBs" (they arrive as raw GLB despite
// the .glb.br name) and report structure + bounds.
import fs from "node:fs";
import path from "node:path";

const dir = process.env.TEMP + "\\opencode\\mpmodels";
for (const name of ["earthmoon", "planet"]) {
  const br = path.join(dir, name + ".glb.br");
  const out = path.join(dir, name + ".glb");
  const dec = fs.readFileSync(br);
  fs.writeFileSync(out, dec); // keep a clean .glb copy
  const magic = dec.slice(0, 4).toString("ascii");
  const version = dec.readUInt32LE(4);
  const jsonLen = dec.readUInt32LE(12);
  const jsonType = dec.slice(16, 20).toString("ascii");
  const json = JSON.parse(dec.slice(20, 20 + jsonLen).toString("utf8"));
  console.log(`${name}: ${dec.length}B magic=${magic} v${version} chunk=${jsonType}`);
  console.log(`  gltf=${json.asset?.version}, meshes=${(json.meshes || []).length}, materials=${(json.materials || []).length}, images=${(json.images || []).length}, anims=${(json.animations || []).length}`);
  let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const acc of json.accessors || []) {
    if (acc.type === "VEC3" && acc.min && acc.max) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], acc.min[i]);
        hi[i] = Math.max(hi[i], acc.max[i]);
      }
    }
  }
  console.log(`  bounds ${lo.map(v => +v.toFixed(2))} .. ${hi.map(v => +v.toFixed(2))}`);
  console.log(`  scenes=${(json.scenes || []).length}, nodes=${(json.nodes || []).length}, names=${(json.nodes || []).map(n => n.name).filter(Boolean).slice(0, 6).join(", ")}`);
}
