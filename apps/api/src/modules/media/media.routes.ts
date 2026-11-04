import { completeUploadSchema, createUploadSchema, idParamsSchema } from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { MediaService } from './media.service.js';

/**
 * Two-step direct upload: POST /uploads returns signed ImageKit credentials; the browser uploads the
 * bytes straight to ImageKit (the API never proxies files); POST /uploads/:id/complete verifies the result.
 */
export function createMediaRouter({
  media,
  auth,
  limiter,
}: {
  media: MediaService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}): Router {
  const router = Router();
  const uploads = rateLimit(limiter, RateLimits.mediaUploads);
  router.use(auth.requireOnboarded);

  router.post(
    '/uploads',
    uploads,
    validated({ body: createUploadSchema }, async ({ body }, req, res) => {
      sendData(res, await media.createUpload(currentUser(req), body), 201);
    }),
  );
  router.post(
    '/uploads/:id/complete',
    uploads,
    validated(
      { params: idParamsSchema, body: completeUploadSchema },
      async ({ params, body }, req, res) => {
        sendData(res, await media.completeUpload(currentUser(req), params.id, body.fileId));
      },
    ),
  );
  return router;
}
