import { z } from 'zod';

export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

/** MongoDB ObjectId as a 24-char hex string. Validating early keeps CastErrors out of the data layer. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

/** Query string accepted by every cursor-paginated list endpoint. */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
