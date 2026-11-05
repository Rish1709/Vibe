import { apiErrorSchema, type ApiSuccess, type ErrorCode } from '@vibe/shared';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** 4xx errors are the caller's fault and will fail again if retried unchanged. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Overrides CLIENT_TIMEOUT_MS. */
  timeoutMs?: number;
}

type TokenGetter = () => Promise<string | null>;
let getAuthToken: TokenGetter = () => Promise.resolve(null);

/**
 * Registered by the auth layer once Clerk loads. Clerk session tokens live ~60s, so a fresh token
 * is requested per call (Clerk caches and refreshes it) instead of storing one at sign-in.
 */
export function setAuthTokenGetter(getter: TokenGetter): void {
  getAuthToken = getter;
}

/** A fresh session token, for transports other than fetch (the realtime socket). */
export const currentAuthToken = (): Promise<string | null> => getAuthToken();

/** A body that isn't JSON is treated as empty, unless reading it stopped because time ran out. */
const readFailure = (deadline: AbortSignal) => (err: unknown) => {
  if (deadline.aborted) throw err;
  return null;
};

/**
 * The longest a call may take, token included. Longer than the API's own 15s request timeout, so a
 * slow server answers with its 503 first; this catches what the server can't: a request that never
 * left the browser (a dead connection, a token refresh that never returns).
 */
export const CLIENT_TIMEOUT_MS = 20_000;

const timedOut = () =>
  new ApiError(0, 'REQUEST_TIMEOUT', 'This is taking too long. Check your connection and retry.');

/** Resolves like `promise`, or rejects once the deadline passes. */
function withDeadline<T>(promise: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) return Promise.reject(timedOut());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut());
    deadline.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => deadline.removeEventListener('abort', onAbort));
  });
}

/**
 * Thin fetch wrapper: JSON in, typed envelope out, and every non-2xx response
 * (including network failures, timeouts and non-JSON error pages) normalized into an ApiError.
 */
export async function apiRequest<T>(
  path: string,
  { method = 'GET', body, signal, timeoutMs = CLIENT_TIMEOUT_MS }: RequestOptions = {},
): Promise<ApiSuccess<T>> {
  // One deadline for the whole call. Without it, a stalled connection left buttons spinning forever.
  const deadline = AbortSignal.timeout(timeoutMs);
  const token = await withDeadline(getAuthToken(), deadline);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    payload = response.status === 204 ? null : await response.json().catch(readFailure(deadline));
  } catch (err) {
    // The caller cancelled (React Query unmounting, a newer search): let it propagate untouched.
    if (signal?.aborted) throw err;
    if (deadline.aborted) throw timedOut();
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'SERVICE_UNAVAILABLE', 'Network error. Check your connection.');
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (parsed.success) {
      const { code, message, details, requestId } = parsed.data.error;
      throw new ApiError(response.status, code, message, details, requestId);
    }
    throw new ApiError(
      response.status,
      response.status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
      `Request failed with status ${response.status}`,
    );
  }

  // The server owns the response contract; shared types keep both sides in sync at compile time.
  return payload as ApiSuccess<T>;
}
