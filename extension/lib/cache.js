// A small verdict cache over a chrome.storage.local-like area (get/set/remove).
// Keys are hashes (see text.js), values are { scores, reason, at }. Post text
// and image bytes are never stored.

export function createCache(area, { max = 5000, pruneEvery = 50 } = {}) {
  let writes = 0;

  async function get(key) {
    const got = await area.get(key);
    return got?.[key] ?? null;
  }

  async function set(key, verdict) {
    const entry = { scores: roundScores(verdict.scores), reason: String(verdict.reason || '').slice(0, 200), at: Date.now() };
    await area.set({ [key]: entry });
    if (++writes >= pruneEvery) {
      writes = 0;
      await prune();
    }
    return entry;
  }

  async function entries() {
    const all = await area.get(null);
    return Object.entries(all || {}).filter(([k]) => k.startsWith('sitr:t:') || k.startsWith('sitr:m:'));
  }

  async function prune() {
    const saved = await entries();
    if (saved.length <= max) return 0;
    saved.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    const drop = saved.slice(0, saved.length - max).map(([k]) => k);
    await area.remove(drop);
    return drop.length;
  }

  async function clear() {
    const keys = (await entries()).map(([k]) => k);
    if (keys.length) await area.remove(keys);
    return keys.length;
  }

  async function count() {
    return (await entries()).length;
  }

  return { get, set, prune, clear, count };
}

export function roundScores(scores) {
  const out = {};
  for (const [k, v] of Object.entries(scores || {})) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
  }
  return out;
}
