import type { IncomingHttpHeaders } from 'node:http';
import { verifyWebhook, type WebhookEvent } from '@clerk/backend/webhooks';
import express, { Router } from 'express';
import type { Logger } from '../../infra/logger.js';
import { Errors } from '../../lib/errors.js';
import { sendData } from '../../lib/response.js';
import { joinName, type IdentityProfile } from '../users/identity.js';
import type { UserService } from '../users/user.service.js';

type UserEvent = Extract<WebhookEvent, { type: 'user.created' | 'user.updated' }>;

function toIdentityProfile(data: UserEvent['data']): IdentityProfile {
  const primaryEmail = data.email_addresses.find(
    (email) => email.id === data.primary_email_address_id,
  );
  return {
    clerkId: data.id,
    email: primaryEmail?.email_address ?? null,
    name: joinName(data.first_name, data.last_name),
    imageUrl: data.has_image ? data.image_url : null,
    updatedAt: new Date(data.updated_at),
  };
}

function toFetchHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return result;
}

/**
 * Delivery is at-least-once and unordered, so every handler is idempotent:
 * create/update apply only if newer than what is stored, and delete is a repeatable soft delete.
 */
async function handleEvent(event: WebhookEvent, users: UserService, log: Logger): Promise<void> {
  switch (event.type) {
    case 'user.created':
    case 'user.updated': {
      const outcome = await users.applyIdentity(toIdentityProfile(event.data));
      log.info({ type: event.type, clerkId: event.data.id, outcome }, 'Clerk user event processed');
      return;
    }
    case 'user.deleted': {
      if (!event.data.id) {
        log.warn({ type: event.type }, 'Clerk user.deleted event without an id');
        return;
      }
      await users.markDeleted(event.data.id, new Date(event.timestamp));
      log.info({ type: event.type, clerkId: event.data.id }, 'Clerk user deleted');
      return;
    }
    default:
      log.debug({ type: event.type }, 'Ignoring unhandled Clerk event');
  }
}

interface WebhookRouterDeps {
  users: UserService;
  signingSecret: string | undefined;
}

/**
 * Mounted before the global JSON parser: signature verification needs the exact raw bytes,
 * and re-serializing parsed JSON would not reproduce them.
 */
export function createClerkWebhookRouter({ users, signingSecret }: WebhookRouterDeps): Router {
  const router = Router();

  router.post(
    '/clerk',
    express.raw({ type: 'application/json', limit: '512kb' }),
    async (req, res) => {
      if (!signingSecret) throw Errors.serviceUnavailable('Clerk webhooks are not configured');
      if (!Buffer.isBuffer(req.body)) throw Errors.badRequest('Expected an application/json body');

      let event: WebhookEvent;
      try {
        event = await verifyWebhook(
          new Request('http://localhost/webhooks/clerk', {
            method: 'POST',
            headers: toFetchHeaders(req.headers),
            body: req.body,
          }),
          { signingSecret },
        );
      } catch (err) {
        // Covers bad signatures and stale timestamps (replay protection).
        req.log.warn({ err }, 'Clerk webhook rejected');
        throw Errors.badRequest('Invalid webhook signature');
      }

      await handleEvent(event, users, req.log);
      sendData(res, { received: true });
    },
  );

  return router;
}
