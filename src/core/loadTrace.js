/**
 * Load instrumentation (devtest only): where the waiting actually goes.
 *
 * The two loading phases are gated by REAL work — tile queues draining, bytes
 * landing — so "it takes a while" had no breakdown: which warm pass, the DEM
 * grid, or the finish drain? This records a timestamp per stage the first time
 * it is reached and counts tile requests by host and by Cesium level, so a
 * probe can print the split instead of guessing.
 *
 * `classifyTileUrl` is pure (URL in, {host, level} out) and unit-tested; the
 * recorder itself is a thin, allocation-free accumulator that costs nothing
 * until it is asked for a report.
 */

/**
 * Split a tile URL into its host and LOD level.
 *
 * Both services put the level in the path:
 *   imagery  .../MapServer/tile/16/23456/11234
 *   terrain  .../cesium-mesh/ellipsoid/14/2776/6592.terrain?v=1.0.0
 * so the level is the first integer of the trailing integer triple. Anything
 * that does not look like a tile (the tileset.json, attribution, sounds)
 * returns null and is not counted as a tile.
 *
 * @param {string} url
 * @returns {{host: string, level: number} | null}
 */
export function classifyTileUrl(url) {
  const s = String(url || "");
  if (!s) return null;
  const m = /\/(\d{1,2})\/(\d+)\/(\d+)(?:\.\w+)?(?:\?|#|$)/.exec(s);
  if (!m) return null;
  const level = parseInt(m[1], 10);
  if (!Number.isFinite(level)) return null;
  let host = "";
  try {
    host = new URL(s, "https://local.invalid").host || "";
  } catch (e) {
    host = "unknown";
  }
  return { host, level };
}

/** Devtest hook: count every tile request the page makes. Idempotent. */
export function installRequestCounter(trace) {
  if (typeof window === "undefined" || window.__tileCounterInstalled) return;
  window.__tileCounterInstalled = true;
  const count = (url) => {
    const info = classifyTileUrl(url);
    if (info) trace.countTile(info.host, info.level);
  };
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try { count(typeof input === "string" ? input : input && input.url); } catch (e) { /* counting is best-effort */ }
      return origFetch.call(this, input, init);
    };
  }
  const origOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  if (typeof origOpen === "function") {
    window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { count(url); } catch (e) { /* best-effort */ }
      return origOpen.call(this, method, url, ...rest);
    };
  }
}

export function createLoadTrace(now = () => performance.now()) {
  const start = now();
  const marks = {};
  const hosts = {};
  const levels = {};
  let tiles = 0;

  return {
    /** First time this name is reached wins (idempotent: re-entry is not a new stage). */
    mark(name) {
      const key = String(name);
      if (!(key in marks)) marks[key] = Math.round(now() - start);
      return marks[key];
    },
    countTile(host, level) {
      tiles++;
      hosts[host] = (hosts[host] || 0) + 1;
      const bucket = String(level);
      levels[bucket] = (levels[bucket] || 0) + 1;
    },
    /** Snapshot for a probe: stage timings in ms since page start, then the request split. */
    report() {
      return {
        elapsedMs: Math.round(now() - start),
        marks: { ...marks },
        tiles,
        hosts: { ...hosts },
        levels: { ...levels },
      };
    },
  };
}
