import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import type { AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { createUserController } from './user.controller.js';
import type { UserService } from './user.service.js';

interface UserRouterDeps {
  users: UserService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}

export function createUserRouter({ users, auth, limiter }: UserRouterDeps): Router {
  const controller = createUserController(users);
  const accountWrites = rateLimit(limiter, RateLimits.accountWrites);
  const router = Router();

  router.use(auth.requireAuth, rateLimit(limiter, RateLimits.authenticated));

  // Available before onboarding: the client needs these to finish setting up the account.
  router.get('/me', controller.getMe);
  router.post('/me/onboarding', accountWrites, controller.completeOnboarding);
  router.get(
    '/username-availability',
    rateLimit(limiter, RateLimits.usernameCheck),
    controller.checkUsername,
  );

  router.patch('/me', auth.requireOnboarded, accountWrites, controller.updateProfile);
  router.patch('/me/settings', auth.requireOnboarded, accountWrites, controller.updateSettings);
  router.get('/:username', auth.requireOnboarded, controller.getProfile);

  return router;
}
