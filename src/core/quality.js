/**
 * Auto quality tier — one detection, frozen profiles.
 *
 * Directive from the project owner: graphics must stay pretty realistic on
 * EVERY device. So the tiers differ ONLY in things you cannot see in motion:
 * MSAA level (fxaa stays on everywhere), tile-cache size (per-frame
 * invisible; only affects re-fetching tiles you've left), tile-upload
 * pacing, a HiDPI pixel-ratio cap, and the explosion's puff budget.
 *
 * Never tiered — identical on every device:
 *   resolutionScale (always 1), maximumScreenSpaceError (always 2),
 *   terrain lighting, atmosphere, fog, fxaa, anisotropy, explosion style.
 *
 * deriveQualityProfile() is pure (unit-tested); getQualityProfile() does the
 * browser probing and caches the result.
 */

export const QUALITY_TIERS = {
  HIGH: "high",
  LOW: "low",
};

const HIGH_PROFILE = Object.freeze({
  tier: QUALITY_TIERS.HIGH,
  // Byte-for-byte the values the game shipped with before tiers existed.
  msaaSamples: 4,
  tileCacheSize: 2048,
  loadingDescendantLimit: 48,
  pixelRatioCap: Infinity,
  explosionScale: 1,
  resolutionScale: 1,
  maximumScreenSpaceError: 2,
});

const LOW_PROFILE = Object.freeze({
  tier: QUALITY_TIERS.LOW,
  // Visually-invisible reductions only. The 600-tile cache (vs 2048) is the
  // big one: 2048 hi-res tiles hoard ~0.5-2 GB of GPU textures, which is
  // what freezes low-VRAM machines in the first place.
  msaaSamples: 2,
  tileCacheSize: 600,
  loadingDescendantLimit: 24,
  pixelRatioCap: 1.75,
  explosionScale: 0.7,
  resolutionScale: 1,
  maximumScreenSpaceError: 2,
});

// Integrated / mobile / software GPUs: not enough VRAM headroom for the
// 2048-tile hoard. Matched case-insensitively against the WebGL renderer
// string. Apple's M-series reports "Apple GPU" and Safari gives no
// deviceMemory — shared-memory GPUs with a big cache are exactly the freeze
// profile we're protecting, so they land here too (msaa 2 + cache 600 keeps
// them realistic AND smooth).
const LOW_GPU_PATTERN =
  /intel|iris|uhd|hd graphics|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe|software|basic render|mesa|d3d11/i;

/**
 * @param {{gpuRenderer?: string, deviceMemoryGB?: number, isMobile?: boolean,
 *          devicePixelRatio?: number}} inputs
 * @returns {Readonly<{tier: string, msaaSamples: number, tileCacheSize: number,
 *   loadingDescendantLimit: number, pixelRatioCap: number, explosionScale: number,
 *   resolutionScale: number, maximumScreenSpaceError: number}>}
 */
export function deriveQualityProfile(inputs = {}) {
  const gpu = String(inputs.gpuRenderer || "");
  const mem = Number(inputs.deviceMemoryGB);
  const isMobile = !!inputs.isMobile;

  if (isMobile) return LOW_PROFILE;
  if (Number.isFinite(mem) && mem > 0 && mem <= 4) return LOW_PROFILE;
  if (gpu && LOW_GPU_PATTERN.test(gpu)) return LOW_PROFILE;
  return HIGH_PROFILE;
}

let _profile = null;

/** Detect once, cache. Any probing failure falls back to the high tier. */
export function getQualityProfile() {
  if (_profile) return _profile;
  let inputs = {};
  try {
    inputs = {
      gpuRenderer: detectGpuRenderer(),
      deviceMemoryGB: navigator.deviceMemory,
      isMobile: detectMobile(),
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  } catch (e) { /* stay with empty inputs → high tier */ }
  _profile = deriveQualityProfile(inputs);
  return _profile;
}

function detectGpuRenderer() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "") : "";
    // Release the probe context immediately - browsers cap live WebGL
    // contexts and the game creates three real ones.
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) { /* best effort */ }
    return renderer;
  } catch (e) {
    return "";
  }
}

function detectMobile() {
  try {
    const ua = (navigator.userAgent || "").toLowerCase();
    return /android|iphone|ipad|ipod|mobile|silk|kindle/i.test(ua)
      || (navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) <= 900);
  } catch (e) {
    return false;
  }
}
