/** Subsequence fuzzy match. Returns a score (higher is better) or null. */
export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastHit = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    score += lastHit === ti - 1 ? 3 : 1; // reward runs
    if (ti === 0 || "/ -_.".includes(t[ti - 1])) score += 2; // word starts
    lastHit = ti;
    qi++;
  }
  if (qi < q.length) return null;
  return score - t.length * 0.01; // mild preference for shorter targets
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 60,
): T[] {
  const scored: [number, T][] = [];
  for (const item of items) {
    const s = fuzzyScore(query, key(item));
    if (s !== null) scored.push([s, item]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, item]) => item);
}
