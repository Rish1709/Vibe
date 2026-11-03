import type { ErrorCode } from '@vibe/shared';

/**
 * An expected, client-facing failure. Anything thrown that is not an AppError is
 * treated as a bug: logged with its stack and reported to the client as a generic 500.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const Errors = {
  badRequest: (message: string, details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message),
  conflict: (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSeconds }),
  serviceUnavailable: (message: string, details?: unknown) =>
    new AppError(503, 'SERVICE_UNAVAILABLE', message, details),
  internal: (cause: unknown) =>
    new AppError(500, 'INTERNAL_ERROR', 'Internal server error', undefined, { cause }),
  usernameTaken: () => new AppError(409, 'USERNAME_TAKEN', 'That username is already taken'),
  onboardingRequired: () =>
    new AppError(403, 'ONBOARDING_REQUIRED', 'Choose a username to finish setting up your account'),
  accountDeleted: () => new AppError(403, 'ACCOUNT_DELETED', 'This account has been deleted'),
};

/** MongoDB rejected a write because it would violate a unique index. */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
