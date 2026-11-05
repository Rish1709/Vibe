import { z } from 'zod';
import { paginationQuerySchema } from './pagination.js';
import type { UserSearchResultDto } from './social.js';

export const POST_SEARCH_QUERY_MAX = 100;

export const postSearchQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1, 'Type something to search').max(POST_SEARCH_QUERY_MAX),
});
export type PostSearchQuery = z.infer<typeof postSearchQuerySchema>;

/** A hashtag as it appears in a URL: optional '#', any case. Stored tags are lowercase. */
export const hashtagParamsSchema = z.object({
  tag: z
    .string()
    .trim()
    .regex(/^#?[\p{L}\p{N}_]{1,50}$/u, 'Not a valid hashtag')
    .transform((tag) => tag.replace(/^#/, '').toLowerCase()),
});

export interface TrendingHashtagDto {
  tag: string;
  /** Posts using the tag in the window. */
  posts: number;
  /** Distinct accounts using it: the ranking signal, so one account can't make a tag trend. */
  authors: number;
}

export interface SuggestedUserDto extends UserSearchResultDto {
  /** How many people the viewer follows also follow this account (0 for popular-account fallback). */
  mutuals: number;
}

export const suggestionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(10),
});
