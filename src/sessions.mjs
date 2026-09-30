/**
 * Per-conversation routing state (main agent, each sub-agent, each parallel session), keyed
 * by a stable identifier the adapter derives. Least-recently-used entries are evicted so a
 * long session cannot grow the map without bound.
 */
export function createSessionStore(max = 256) {
  const map = new Map();
  return {
    get(key) {
      let s = map.get(key);
      if (s) map.delete(key);
      else s = { model: null, turnId: null, inflight: null };
      map.set(key, s);
      if (map.size > max) map.delete(map.keys().next().value);
      return s;
    },
    get size() {
      return map.size;
    },
  };
}
