// Inspect a GLB: chunk layout, scene graph, node transforms, mesh bounds and
// materials. Needed to place a new aircraft model correctly rather than
// guessing at its scale and orientation.
import { readFileSync } from "node:fs";

const path = process.argv[2] || "C:/Users/jaxzc.JACKSON/Downloads/airplane_crj-900_cityjet.glb";
const buf = readFileSync(path);

const magic = buf.readUInt32LE(0);
const version = buf.readUInt32LE(4);
let off = 12;
const chunks = [];
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  chunks.push({ type, len, at: off + 8 });
  off += 8 + len + ((4 - (len % 4)) % 4);
}
console.log("file      ", path);
console.log("magic     ", magic.toString(16), magic === 0x46546c67 ? "(glTF)" : "(NOT glTF)");
console.log("version   ", version, " size", buf.length);
console.log("chunks    ", chunks.map((c) => `${c.type}(${c.len})`).join(" "));

const json = JSON.parse(buf.toString("utf8", chunks[0].at, chunks[0].at + chunks[0].len));
console.log(
  "\ncounts     meshes", json.meshes?.length ?? 0,
  " nodes", json.nodes?.length ?? 0,
  " materials", json.materials?.length ?? 0,
  " images", json.images?.length ?? 0,
  " textures", json.textures?.length ?? 0,
  " anims", (json.animations || []).length,
);
console.log("generator  ", json.asset?.generator || "(none)");
console.log("copyright  ", json.asset?.copyright || "(none)");
if (json.extensionsRequired?.length) console.log("required   ", json.extensionsRequired.join(", "));

// Binary chunk layout: accessors may be sparse, so map each view by its own
// bufferView rather than assuming a single interleaved blob.
const bin = chunks.find((c) => c.type === "BIN");
const readVec = (accIdx) => {
  const acc = json.accessors[accIdx];
  if (!acc) return null;
  const bv = json.bufferViews[acc.bufferView];
  const base = bin ? bin.at + (bv.byteOffset || 0) + (acc.byteOffset || 0) : 0;
  const n = acc.count;
  const out = [];
  const stride = bv.byteStride || 0;
  for (let i = 0; i < n; i++) {
    const p = base + i * (stride || 0);
    if (acc.type === "VEC3") {
      out.push([buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)]);
    } else if (acc.type === "VEC4") {
      out.push([buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)]);
    } else if (acc.type === "SCALAR") {
      out.push(buf.readFloatLE(p));
    } else {
      out.push(null);
      break;
    }
  }
  return out;
};

// Node hierarchy with local transforms.
console.log("\nscene nodes:", JSON.stringify(json.scenes?.[0]?.nodes));
const walk = (idx, depth) => {
  const n = json.nodes[idx];
  if (!n) return;
  const t = n.translation ? `T(${n.translation.map((v) => +v.toFixed(3))})` : "";
  const r = n.rotation ? `R(${n.rotation.map((v) => +v.toFixed(3))})` : "";
  const s = n.scale ? `S(${n.scale.map((v) => +v.toFixed(3))})` : "";
  const m = n.mesh !== undefined ? `mesh=${n.mesh} [${json.meshes[n.mesh]?.name || "?"}]` : "";
  console.log(`${"  ".repeat(depth)}node ${idx} "${n.name || ""}" ${t} ${r} ${s} ${m}`.trim());
  for (const c of n.children || []) walk(c, depth + 1);
};
for (const r of json.scenes?.[0]?.nodes || []) walk(r, 0);

// World-space bounds, honouring node transforms, to get the model's real size.
console.log("\nmesh bounds (POSITION accessor min/max, as authored):");
for (const m of json.meshes || []) {
  for (const p of m.primitives || []) {
    const acc = json.accessors[p.attributes?.POSITION];
    if (!acc) continue;
    console.log(
      `  ${(m.name || "mesh").padEnd(22)} verts ${String(acc.count).padStart(6)}`,
      `min ${acc.min?.map((v) => +v.toFixed(3)).join(", ")}`,
      `max ${acc.max?.map((v) => +v.toFixed(3)).join(", ")}`,
      `mat ${p.material ?? "-"}`,
    );
  }
}

// Materials tell us whether the model has real textures (so it can be tinted
// properly) or is flat-shaded.
console.log("\nmaterials:");
for (const [i, mat] of (json.materials || []).entries()) {
  const pbr = mat.pbrMetallicRoughness || {};
  console.log(
    `  ${i}: "${mat.name || ""}" base=${JSON.stringify(pbr.baseColorFactor || null)}`,
    `tex=${pbr.baseColorTexture ? "yes" : "no"}`,
    `doubleSided=${!!mat.doubleSided} alphaMode=${mat.alphaMode || "OPAQUE"}`,
  );
}
