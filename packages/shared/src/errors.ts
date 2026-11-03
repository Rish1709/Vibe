/**
 * Machine-readable error codes returned in every error response.
 * Clients branch on `code`, never on `message` (messages are for humans and may change).
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'ONBOARDING_REQUIRED',
  'ACCOUNT_DELETED',
  'USERNAME_TAKEN',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'REQUEST_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
