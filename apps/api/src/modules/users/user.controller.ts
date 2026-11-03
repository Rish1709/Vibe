import {
  onboardingSchema,
  updateProfileSchema,
  updateSettingsSchema,
  usernameAvailabilityQuerySchema,
  usernameParamsSchema,
} from '@vibe/shared';
import { sendData } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser } from '../../middleware/auth.js';
import type { UserService } from './user.service.js';

/** HTTP adapters only: parse input, call the service, shape the response. No business rules here. */
export function createUserController(users: UserService) {
  return {
    getMe: validated({}, async (_input, req, res) => {
      sendData(res, await users.getMe(currentUser(req)));
    }),

    completeOnboarding: validated({ body: onboardingSchema }, async ({ body }, req, res) => {
      sendData(res, await users.completeOnboarding(currentUser(req), body));
    }),

    updateProfile: validated({ body: updateProfileSchema }, async ({ body }, req, res) => {
      sendData(res, await users.updateProfile(currentUser(req), body));
    }),

    updateSettings: validated({ body: updateSettingsSchema }, async ({ body }, req, res) => {
      sendData(res, await users.updateSettings(currentUser(req), body));
    }),

    checkUsername: validated(
      { query: usernameAvailabilityQuerySchema },
      async ({ query }, req, res) => {
        sendData(res, await users.checkUsernameAvailability(query.username, currentUser(req)));
      },
    ),

    getProfile: validated({ params: usernameParamsSchema }, async ({ params }, _req, res) => {
      sendData(res, await users.getProfileByUsername(params.username));
    }),
  };
}
