import { z } from 'zod';
import { ERROR_CODES } from './errors.js';

/** Pagination metadata. `nextCursor` is null when there are no more pages. */
export interface PageMeta {
  nextCursor: string | null;
}

/** Envelope for every successful response. */
export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});

/** Envelope for every error response. */
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

/** One entry in `error.details` for VALIDATION_ERROR responses. */
export interface ValidationIssue {
  location: 'body' | 'query' | 'params';
  path: string;
  message: string;
}
