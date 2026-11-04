/**
 * Display-name search keys. A case-insensitive regex can't use an index efficiently, so names are
 * stored pre-normalized as an indexed array of words, and queries become anchored prefix matches
 * (`^gra`) on that array: an index range scan, like the username prefix match.
 */
const MAX_TOKENS = 8;

/** Lowercase and accent-free, so "José" is found by "jose". Used for stored keys and queries alike. */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The distinct words of a display name, normalized: "Grace B. Hopper" → ["grace", "b", "hopper"]. */
export function searchTokensFor(displayName: string): string[] {
  const words = normalizeForSearch(displayName)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_TOKENS);
}
