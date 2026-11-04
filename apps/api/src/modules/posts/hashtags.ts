import { HASHTAGS_MAX } from '@vibe/shared';

const HASHTAG_MAX_LENGTH = 50;
// A '#' at the start or after a non-word character, followed by letters/digits/underscores (Unicode-aware).
const HASHTAG_PATTERN = /(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]+)/gu;

/**
 * Lowercased, deduplicated, in order of first appearance, capped in count and length.
 * The caps bound the multikey index: each tag is one index entry per post.
 */
export function extractHashtags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = match[1]?.toLowerCase();
    if (!tag || tag.length > HASHTAG_MAX_LENGTH || /^\d+$/.test(tag)) continue;
    tags.add(tag);
    if (tags.size === HASHTAGS_MAX) break;
  }
  return [...tags];
}
