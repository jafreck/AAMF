const GLOB_META = /[*?\[\]{}!()]/;

/**
 * Normalize source exclusions into root-relative glob patterns for Lore.
 * Plain directory names match at any depth; plain paths match that subtree;
 * explicit glob patterns are preserved after slash normalization.
 */
export function normalizeSourceExcludePatterns(patterns: readonly string[]): string[] {
  const normalized = patterns.flatMap(pattern => {
    const clean = pattern.trim()
      .replaceAll('\\', '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    if (!clean) return [];
    if (GLOB_META.test(clean)) return [clean];
    if (clean.includes('/')) return [`${clean}/**`];
    return [`**/${clean}/**`];
  });
  return [...new Set(normalized)].sort();
}
